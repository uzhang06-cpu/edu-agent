/**
 * server.js — 星光教育 AI 智能助手后端主服务
 * 含用户登录注册 + MongoDB 会话持久化
 */

require('./db'); // 连接 MongoDB

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const path         = require('path');
const jwt          = require('jsonwebtoken');

const config          = require('./config');
const { runAgent }    = require('./agent/pipeline');
const knowledge       = require('./knowledge');
const { router: skillsRouter }    = require('./skills');
const { router: toolsRouter }     = require('./tools');
const { router: workflowsRouter } = require('./workflows');
const authRouter      = require('./routes/auth');
const authMiddleware  = require('./middleware/auth');
const Session         = require('./models/Session');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());

// ════════════════════════════════════════════════════════════════
//  认证路由（无需登录）
// ════════════════════════════════════════════════════════════════
app.use('/api/auth', authRouter);

// ════════════════════════════════════════════════════════════════
//  健康检查（无需登录，UptimeRobot 用）
// ════════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  const keyConfigured = !!(
    config.DEEPSEEK_API_KEY &&
    !config.DEEPSEEK_API_KEY.includes('填写') &&
    config.DEEPSEEK_API_KEY.startsWith('sk-')
  );
  res.json({
    status:           'ok',
    apiKeyConfigured: keyConfigured,
    schoolName:       config.SCHOOL_NAME,
    model:            config.deepseek.model,
    ragEnabled:       config.rag.enabled,
  });
});

// ════════════════════════════════════════════════════════════════
//  课程列表（无需登录）
// ════════════════════════════════════════════════════════════════
app.get('/api/courses', (req, res) => {
  res.json({
    courses: [
      {
        name: '精英班', price: 19800, duration: '年',
        features: ['每周2次一对一直播', '7×12h答疑', '月度学情报告', '48节课/年'],
      },
      {
        name: '提升班', price: 9800, duration: '年',
        features: ['每周1次小班直播(6人)', '5×10h答疑', '季度学情报告', '36节课/年'],
      },
      {
        name: '基础班', price: 3800, duration: '年',
        features: ['每周录播课(7天回放)', '社群答疑', '电子讲义', '48节录播/年'],
      },
      {
        name: '单科强化班', price: 2200, duration: '学期',
        features: ['数/语/英/物/化任选', '每周直播+作业批改', '2科9折 · 3科8.5折'],
      },
    ]
  });
});

// ════════════════════════════════════════════════════════════════
//  会话 API（需要登录）
// ════════════════════════════════════════════════════════════════

/** GET /api/sessions — 当前用户的会话列表 */
app.get('/api/sessions', authMiddleware, async (req, res) => {
  try {
    const sessions = await Session.find({ userId: req.user.userId })
      .select('id title lastUpdate summary')
      .sort({ lastUpdate: -1 });
    res.json({ sessions: sessions.map(s => s.toJSON()) });
  } catch (err) {
    res.status(500).json({ error: '获取会话列表失败' });
  }
});

/** POST /api/sessions — 创建新会话 */
app.post('/api/sessions', authMiddleware, async (req, res) => {
  try {
    const session = await Session.create({ userId: req.user.userId });
    res.json(session.toJSON());
  } catch (err) {
    res.status(500).json({ error: '创建会话失败' });
  }
});

/** GET /api/sessions/:id — 获取会话详情（含消息） */
app.get('/api/sessions/:id', authMiddleware, async (req, res) => {
  try {
    const session = await Session.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session.toJSON());
  } catch (err) {
    res.status(500).json({ error: '获取会话失败' });
  }
});

/** DELETE /api/sessions/:id — 删除当前用户的某次会话 */
app.delete('/api/sessions/:id', authMiddleware, async (req, res) => {
  try {
    const result = await Session.deleteOne({ _id: req.params.id, userId: req.user.userId });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '删除会话失败' });
  }
});

// ════════════════════════════════════════════════════════════════
//  文件上传 & 解析（PDF / DOCX / XLSX / 图片 OCR / TXT）
// ════════════════════════════════════════════════════════════════
const multer = require('multer');
const { parseFile } = require('./services/document-parser');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

app.post('/api/upload', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  try {
    const parsed = await parseFile(req.file);
    res.json({
      ok: true,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mime: req.file.mimetype,
      ...parsed
    });
  } catch (err) {
    console.error('[upload]', err);
    res.status(500).json({ error: '文件解析失败: ' + err.message });
  }
});

// ── 知识库 / 技能 / 工具 / 工作流 ───────────────────────────────
app.use('/api/knowledge', knowledge.router);
app.use('/api/skills',    skillsRouter);
app.use('/api/tools',     toolsRouter);
app.use('/api/workflows', workflowsRouter);

// ════════════════════════════════════════════════════════════════
//  静态资源
// ════════════════════════════════════════════════════════════════
app.use(express.static(path.join(__dirname)));

// ════════════════════════════════════════════════════════════════
//  Socket.IO — JWT 鉴权
// ════════════════════════════════════════════════════════════════
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('未登录'));
  try {
    socket.user = jwt.verify(token, config.JWT_SECRET);
    next();
  } catch {
    next(new Error('Token无效'));
  }
});

io.on('connection', (socket) => {
  console.log(`[Socket] 连接: ${socket.id} | 用户: ${socket.user?.username}`);

  // ── 收到用户消息 ────────────────────────────────────────────
  socket.on('chat', async ({ message, sessionId, identity: msgIdentity, fileName, fileContent }) => {
    console.log(`[Chat] User:${socket.user.username} Session:${sessionId} | ${message?.slice(0, 40)}`);

    // 加载会话（验证归属）
    let session = await Session.findOne({ _id: sessionId, userId: socket.user.userId });
    if (!session) {
      session = await Session.create({ userId: socket.user.userId });
    }

    const history = session.messages.map(m => ({ role: m.role, content: m.content }));

    // 拼接：消息正文 +（可选）已解析的文件内容
    let fullMessage = message || '';
    if (fileName) {
      fullMessage += (fullMessage ? '\n\n' : '') + `[用户上传文件：${fileName}]`;
      if (fileContent) {
        fullMessage += `\n以下是文件内容（已自动解析为文本）：\n"""\n${fileContent}\n"""`;
      }
    }

    const identity = msgIdentity || 'parent';

    const result = await runAgent({ socket, message: fullMessage, history, summary: session.summary, identity });

    // 立即返回给前端 —— 摘要异步更新，不阻塞（P0-3）
    socket.emit('response', result);

    if (result.success) {
      session.messages.push({ role: 'user',      content: fullMessage });
      session.messages.push({ role: 'assistant', content: result.response });

      if (session.title === '新咨询项目' && session.messages.length >= 2) {
        session.title = message.slice(0, 15) || '咨询会话';
      }

      // 只保留最近 20 条（10轮）
      if (session.messages.length > 20) {
        session.messages = session.messages.slice(-20);
      }

      session.lastUpdate = new Date();
      await session.save();

      // ── 异步摘要更新（P0-3）：不阻塞用户
      //    条件：每 3 轮更新一次（消息条数为 6, 12, 18 时触发）
      const shouldUpdateSummary = typeof result.updateSummary === 'function'
        && (session.messages.length % 6 === 0 || session.messages.length === 2);
      if (shouldUpdateSummary) {
        // fire-and-forget
        result.updateSummary().then(async (newSummary) => {
          if (newSummary && newSummary !== session.summary) {
            try {
              await Session.findOneAndUpdate(
                { _id: session._id },
                { summary: newSummary }
              );
              console.log(`[Summary] Session:${session._id} updated (${newSummary.length} chars)`);
            } catch (e) {
              console.warn('[Summary] save fail:', e.message);
            }
          }
        }).catch(e => console.warn('[Summary] update fail:', e.message));
      }
    }
  });

  // ── 清空对话 ────────────────────────────────────────────────
  socket.on('clear_history', async ({ sessionId }) => {
    await Session.findOneAndUpdate(
      { _id: sessionId, userId: socket.user.userId },
      { messages: [], summary: '', lastUpdate: new Date() }
    );
    console.log(`[Chat] Session:${sessionId} 历史已清空`);
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] 断开: ${socket.id}`);
  });
});

// ════════════════════════════════════════════════════════════════
//  启动
// ════════════════════════════════════════════════════════════════
server.listen(config.PORT, () => {
  const keyOk = config.DEEPSEEK_API_KEY && !config.DEEPSEEK_API_KEY.includes('填写');
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║  🌟 星光教育 AI 助手后端已启动                     ║`);
  console.log(`║  📡 访问地址: http://localhost:${config.PORT}            ║`);
  console.log(`║  🔑 API Key: ${keyOk ? '✅ 已配置' : '❌ 未配置'}                       ║`);
  console.log(`║  🗄️  MongoDB: ${config.MONGODB_URI ? '✅ 已配置' : '❌ 未配置'}                    ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');
});
