/**
 * server.js
 * ──────────────────────────────────────────────────────────────────
 *  星光教育 AI 智能助手 — 后端主服务
 *
 *  启动方式：
 *    npm install
 *    node server.js          # 生产
 *    npx nodemon server.js   # 开发（热重载）
 *
 *  🔑 修改 API Key → config.js 第20行 或 .env 文件
 * ──────────────────────────────────────────────────────────────────
 */

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const fs       = require('fs');

const config   = require('./config');
const { runAgent } = require('./agent/pipeline');
const knowledge = require('./knowledge');
const { router: skillsRouter }    = require('./skills');
const { router: toolsRouter }     = require('./tools');
const { router: workflowsRouter } = require('./workflows');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const SESSIONS_DIR = path.join(__dirname, 'sessions');

app.use(express.json());
// ⚠️ 静态资源必须放在 API 路由之后，否则 API 会被 index.html 拦截（如果配置了SPA重定向）
// 但在这里 index.html 是静态文件，所以通常没问题。
// 为了稳妥，我们把 API 路由提到前面。

// ════════════════════════════════════════════════════════════════
//  会话管理逻辑 (持久化)
// ════════════════════════════════════════════════════════════════

// 确保 sessions 目录存在
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

function getSessionFilePath(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

function loadSession(sessionId) {
  const file = getSessionFilePath(sessionId);
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { console.error('Load session error:', e); }
  }
  return null;
}

function saveSession(sessionId, data) {
  const file = getSessionFilePath(sessionId);
  data.lastUpdate = Date.now();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function createSession(title = '新咨询项目') {
  const sessionId = 'xg_' + Date.now() + Math.random().toString(36).slice(2, 6);
  const data = {
    id: sessionId,
    title,
    createdAt: Date.now(),
    lastUpdate: Date.now(),
    summary: '',
    messages: []
  };
  saveSession(sessionId, data);
  return data;
}

// 内存缓存 (加速访问)
const sessionCache = new Map();

function getOrLoadSession(sessionId) {
  if (sessionCache.has(sessionId)) return sessionCache.get(sessionId);
  const data = loadSession(sessionId);
  if (data) sessionCache.set(sessionId, data);
  return data;
}

// ════════════════════════════════════════════════════════════════
//  REST API 路由 (优先挂载)
// ════════════════════════════════════════════════════════════════

/** GET /api/sessions — 获取会话列表 */
app.get('/api/sessions', (req, res) => {
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  const list = files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      return { id: data.id, title: data.title, lastUpdate: data.lastUpdate, summary: data.summary };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.lastUpdate - a.lastUpdate);
  res.json({ sessions: list });
});

/** POST /api/sessions — 创建新会话 */
app.post('/api/sessions', (req, res) => {
  const session = createSession();
  sessionCache.set(session.id, session);
  console.log(`[API] Created session: ${session.id}`);
  res.json(session);
});

/** GET /api/sessions/:id — 获取会话详情 */
app.get('/api/sessions/:id', (req, res) => {
  const session = getOrLoadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

/** 健康检查（前端启动时调用）*/
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

/** 课程列表（左侧栏动态加载）*/
app.get('/api/courses', (req, res) => {
  res.json({
    courses: [
      {
        name:     '精英班',
        price:    19800,
        duration: '年',
        features: ['每周2次一对一直播', '7×12h答疑', '月度学情报告', '48节课/年'],
      },
      {
        name:     '提升班',
        price:    9800,
        duration: '年',
        features: ['每周1次小班直播(6人)', '5×10h答疑', '季度学情报告', '36节课/年'],
      },
      {
        name:     '基础班',
        price:    3800,
        duration: '年',
        features: ['每周录播课(7天回放)', '社群答疑', '电子讲义', '48节录播/年'],
      },
      {
        name:     '单科强化班',
        price:    2200,
        duration: '学期',
        features: ['数/语/英/物/化任选', '每周直播+作业批改', '2科9折 · 3科8.5折'],
      },
    ]
  });
});

// ── 知识库 / 技能 / 工具 / 工作流 CRUD 路由 ───────────────────────
app.use('/api/knowledge', knowledge.router);
app.use('/api/skills',    skillsRouter);
app.use('/api/tools',     toolsRouter);
app.use('/api/workflows', workflowsRouter);


// ════════════════════════════════════════════════════════════════
//  静态资源 (最后挂载)
// ════════════════════════════════════════════════════════════════
app.use(express.static(path.join(__dirname)));  // 静态文件（index.html）

// ════════════════════════════════════════════════════════════════
//  Socket.IO — 会话管理 + Agent 调用
// ════════════════════════════════════════════════════════════════

// 对话历史：Map<sessionId, Message[]>
const sessionHistories = new Map();

io.on('connection', (socket) => {
  console.log(`[Socket] 新连接: ${socket.id}`);

  // ── 收到用户消息 ───────────────────────────────────────────────
  socket.on('chat', async ({ message, sessionId, identity: msgIdentity, fileName, fileType }) => {
    console.log(`[Chat] Session:${sessionId} | ${message?.slice(0,40)}${fileName ? ` + 文件:${fileName}` : ''}`);

    // 获取或初始化历史
    let sessionData = getOrLoadSession(sessionId);
    if (!sessionData) {
      // 客户端发来未知ID（可能是旧版缓存），重新创建
      sessionData = createSession('恢复的会话');
      sessionData.id = sessionId; // 尽量保持ID一致（如果不冲突）
      sessionCache.set(sessionId, sessionData);
    }
    
    const history = sessionData.messages;

    // 如有文件，附加到消息
    const fullMessage = fileName
      ? `${message || ''}（用户上传了文件：${fileName}）`
      : message;

    const identity = msgIdentity || socket.handshake.auth?.identity || 'parent';

    // 运行 Agent 流水线
    const result = await runAgent({
      socket,
      message:  fullMessage,
      history,
      summary: sessionData.summary, // 传入摘要
      identity,
    });

    // 更新历史（用于多轮对话上下文）
    if (result.success) {
      history.push({ role: 'user',      content: fullMessage });
      history.push({ role: 'assistant', content: result.response });
      
      // 更新摘要
      if (result.newSummary) {
        sessionData.summary = result.newSummary;
      }
      
      // 自动更新标题 (如果是新会话)
      if (sessionData.title === '新咨询项目' && history.length >= 2) {
        sessionData.title = message.slice(0, 15) || '咨询会话';
      }

      // 持久化保存
      saveSession(sessionId, sessionData);

      // 滑动窗口策略：保留最近 10 条（5轮），更早的已压缩进摘要
      if (history.length > 10) {
        history.splice(0, history.length - 10);
      }
    }

    // 返回结果给前端
    socket.emit('response', result);
  });

  // ── 清空对话历史 ───────────────────────────────────────────────
  socket.on('clear_history', ({ sessionId }) => {
    // 仅清空消息，保留会话文件
    const sessionData = getOrLoadSession(sessionId);
    if (sessionData) {
        sessionData.messages = [];
        sessionData.summary = '';
        saveSession(sessionId, sessionData);
    }
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
  console.log(`║  🔑 API Key: ${keyOk ? '✅ 已配置' : '❌ 未配置（去 config.js 填写）'}            ║`);
  console.log(`║  📚 知识库RAG: ${config.rag.enabled ? '✅ 已启用' : '❌ 已禁用'}                    ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');
  if (!keyOk) {
    console.warn('⚠️  提示：请在 config.js 第20行 或 .env 文件中填写 DEEPSEEK_API_KEY\n');
  }
});
