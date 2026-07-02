/**
 * knowledge/index.js
 * ──────────────────────────────────────────────────────────────────
 *  RAG 知识库引擎 + Express CRUD 路由
 *
 *  对外暴露：
 *    retrieve(query, topK)  → 检索最相关的 K 个片段
 *    router                 → Express Router（CRUD 接口）
 *
 *  知识库文件位于 ./db/*.json，每个文件是一个对象数组：
 *    [{ id, title, tags[], content }, ...]
 *
 *  检索算法：简单 TF-IDF 风格关键词匹配（可替换为向量检索）
 * ──────────────────────────────────────────────────────────────────
 */

const fs     = require('fs');
const path   = require('path');
const { Router } = require('express');
const { hybridRetrieve } = require('./enhanced-retriever');
const retrieverV2        = require('./retriever-v2');  // P1-1 新版
const { recordQuery, recordClick, getUserInterests, getPersonalizedRecommendations, getUserSummary } = require('./user-profile');
const { getKnowledgeStats, getUserActivityStats, getSystemHealth, getDashboardSummary } = require('./dashboard');
const { parseFile, parseFiles, checkDependencies } = require('./file-parser');
const multer = require('multer');

const DB_DIR = path.join(__dirname, 'db');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PROFILES_DIR = path.join(__dirname, 'profiles');

// 确保上传目录存在
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// 配置文件上传
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });
const router = Router();

// ── 加载所有知识库文件 ────────────────────────────────────────────
function loadAllDocs() {
  let docs = [];
  const files = fs.readdirSync(DB_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(DB_DIR, file), 'utf8'));
      docs = docs.concat(raw.map(d => ({ ...d, _file: file })));
    } catch (e) {
      console.error(`[知识库] 加载 ${file} 失败:`, e.message);
    }
  }
  return docs;
}

// ── 关键词打分 ────────────────────────────────────────────────────
function scoreDoc(doc, queryTokens) {
  const haystack = [
    doc.title || '',
    (doc.tags || []).join(' '),
    doc.content || ''
  ].join(' ').toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    if (!token) continue;
    // 标题/tags 命中权重更高
    const titleHit = (doc.title + (doc.tags||[]).join(' ')).toLowerCase().includes(token);
    score += (haystack.split(token).length - 1) * (titleHit ? 3 : 1);
  }
  // 归一化（简单处理）
  return score / (haystack.length / 100 + 1);
}

// ── 中文分词（简单按字符和标点切割，生产可替换 jieba-wasm）────────
function tokenize(text) {
  // 按标点和空白分割，保留2字以上的词
  return text
    .toLowerCase()
    .split(/[\s，。？！、；：""''（）【】\.\?\!\,\;\:]+/)
    .filter(t => t.length >= 2);
}

// ── 核心检索函数（被 agent 调用）────────────────────────────────
// P1-1: 优先走 retriever-v2（BM25 + 常驻内存 + 改进分词），失败降级到旧版
function retrieve(query, topK = 3, minScore = 0.5, useEnhanced = true) {
  // 第一优先：v2（BM25，常驻内存索引）
  try {
    const v2 = retrieverV2.retrieve(query, topK, minScore);
    if (v2 && v2.length) return v2;
    // 空命中不直接失败，尝试次优路径
  } catch (e) {
    console.warn('[知识库] v2 检索失败，回退旧版:', e.message);
  }

  // 第二优先：老 hybridRetrieve（TF-IDF）
  if (useEnhanced) {
    try {
      const results = hybridRetrieve(query, topK, { minScore: Math.min(minScore, 0.15) });
      return results.map(item => ({
        id:      item.id,
        title:   item.title,
        content: item.content,
        score:   item.score,
        source:  item.source,
      }));
    } catch (e) {
      console.error('[知识库] hybridRetrieve 失败，回退基础检索:', e.message);
    }
  }

  // 兜底：老关键词打分
  const docs = loadAllDocs();
  const tokens = tokenize(query);
  const scored = docs
    .map(doc => ({ doc, score: scoreDoc(doc, tokens) }))
    .filter(item => item.score >= Math.min(minScore, 0.15))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  return scored.map(item => ({
    id:      item.doc.id,
    title:   item.doc.title,
    content: item.doc.content,
    score:   Math.round(item.score * 100) / 100,
    source:  item.doc._file,
  }));
}

// ── 格式化为注入 Prompt 的文本 ────────────────────────────────────
function formatForPrompt(chunks) {
  if (!chunks.length) return '';
  const lines = chunks.map((c, i) =>
    `【知识片段${i+1}】${c.title}\n${c.content}`
  );
  return `\n\n---\n以下是从知识库检索到的相关内容，请优先参考：\n${lines.join('\n\n')}\n---\n`;
}

// ════════════════════════════════════════════════════════════════
//  CRUD HTTP 路由（挂载到 /api/knowledge）
// ════════════════════════════════════════════════════════════════

/** GET /api/knowledge — 列出所有文档 */
router.get('/', (req, res) => {
  const docs = loadAllDocs();
  res.json({ total: docs.length, docs });
});

/** GET /api/knowledge/search?q=关键词 — 检索 */
router.get('/search', (req, res) => {
  const { q, topK = 5, enhanced = 'true' } = req.query;
  if (!q) return res.status(400).json({ error: '缺少查询参数 q' });
  const useEnhanced = enhanced !== 'false';
  const results = retrieve(q, Number(topK), 0, useEnhanced);
  res.json({ query: q, results, enhanced: useEnhanced });
});

/** GET /api/knowledge/:id — 获取单条 */
router.get('/:id', (req, res) => {
  const docs = loadAllDocs();
  const doc = docs.find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: '未找到该文档' });
  res.json(doc);
});

/** POST /api/knowledge — 新增文档 */
router.post('/', (req, res) => {
  const { title, tags, content, file = 'custom_kb.json' } = req.body;
  if (!title || !content) return res.status(400).json({ error: '缺少 title 或 content' });

  const filePath = path.join(DB_DIR, file);
  let arr = [];
  if (fs.existsSync(filePath)) {
    arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  const newDoc = {
    id: `kb_custom_${Date.now()}`,
    title,
    tags: tags || [],
    content,
  };
  arr.push(newDoc);
  fs.writeFileSync(filePath, JSON.stringify(arr, null, 2));
  res.status(201).json({ message: '创建成功', doc: newDoc });
});

/** PUT /api/knowledge/:id — 更新文档 */
router.put('/:id', (req, res) => {
  const files = fs.readdirSync(DB_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(DB_DIR, file);
    let arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const idx = arr.findIndex(d => d.id === req.params.id);
    if (idx !== -1) {
      arr[idx] = { ...arr[idx], ...req.body, id: arr[idx].id };
      fs.writeFileSync(filePath, JSON.stringify(arr, null, 2));
      return res.json({ message: '更新成功', doc: arr[idx] });
    }
  }
  res.status(404).json({ error: '未找到该文档' });
});

/** DELETE /api/knowledge/:id — 删除文档 */
router.delete('/:id', (req, res) => {
  const files = fs.readdirSync(DB_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(DB_DIR, file);
    let arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const idx = arr.findIndex(d => d.id === req.params.id);
    if (idx !== -1) {
      arr.splice(idx, 1);
      fs.writeFileSync(filePath, JSON.stringify(arr, null, 2));
      return res.json({ message: '删除成功' });
    }
  }
  res.status(404).json({ error: '未找到该文档' });
});
// ════════════════════════════════════════════════════════════════
//  用户画像 API
// ════════════════════════════════════════════════════════════════

/** POST /api/knowledge/user/query — 记录用户查询 */
router.post('/user/query', (req, res) => {
  const { userId, query, results = [] } = req.body;
  if (!userId || !query) {
    return res.status(400).json({ error: '缺少 userId 或 query' });
  }

  try {
    const success = recordQuery(userId, query, results);
    res.json({ success, message: '查询记录成功' });
  } catch (error) {
    console.error('[用户画像] 记录查询失败:', error);
    res.status(500).json({ error: '记录查询失败', details: error.message });
  }
});

/** POST /api/knowledge/user/click — 记录用户点击 */
router.post('/user/click', (req, res) => {
  const { userId, contentId, contentType = 'knowledge', title = '' } = req.body;
  if (!userId || !contentId) {
    return res.status(400).json({ error: '缺少 userId 或 contentId' });
  }

  try {
    const success = recordClick(userId, contentId, contentType, title);
    res.json({ success, message: '点击记录成功' });
  } catch (error) {
    console.error('[用户画像] 记录点击失败:', error);
    res.status(500).json({ error: '记录点击失败', details: error.message });
  }
});

/** GET /api/knowledge/user/:userId/profile — 获取用户画像摘要 */
router.get('/user/:userId/profile', (req, res) => {
  try {
    const summary = getUserSummary(req.params.userId);
    res.json(summary);
  } catch (error) {
    console.error('[用户画像] 获取用户摘要失败:', error);
    res.status(500).json({ error: '获取用户摘要失败', details: error.message });
  }
});

/** GET /api/knowledge/user/:userId/interests — 获取用户兴趣标签 */
router.get('/user/:userId/interests', (req, res) => {
  const { topN = 10 } = req.query;
  try {
    const interests = getUserInterests(req.params.userId, Number(topN));
    res.json({ userId: req.params.userId, interests });
  } catch (error) {
    console.error('[用户画像] 获取兴趣标签失败:', error);
    res.status(500).json({ error: '获取兴趣标签失败', details: error.message });
  }
});

/** GET /api/knowledge/user/:userId/recommendations — 获取个性化推荐 */
router.get('/user/:userId/recommendations', (req, res) => {
  const { topN = 5 } = req.query;
  try {
    const allDocs = loadAllDocs();
    const recommendations = getPersonalizedRecommendations(req.params.userId, allDocs, Number(topN));
    res.json({ userId: req.params.userId, recommendations });
  } catch (error) {
    console.error('[用户画像] 获取推荐失败:', error);
    res.status(500).json({ error: '获取推荐失败', details: error.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  仪表盘 API
// ════════════════════════════════════════════════════════════════

/** GET /api/knowledge/dashboard/stats — 获取知识库统计 */
router.get('/dashboard/stats', (req, res) => {
  try {
    const stats = getKnowledgeStats();
    res.json(stats);
  } catch (error) {
    console.error('[仪表盘] 获取知识库统计失败:', error);
    res.status(500).json({ error: '获取统计失败', details: error.message });
  }
});

/** GET /api/knowledge/dashboard/activity — 获取用户活跃度统计 */
router.get('/dashboard/activity', (req, res) => {
  try {
    const activity = getUserActivityStats();
    res.json(activity);
  } catch (error) {
    console.error('[仪表盘] 获取用户活跃度失败:', error);
    res.status(500).json({ error: '获取活跃度失败', details: error.message });
  }
});

/** GET /api/knowledge/dashboard/health — 获取系统健康状态 */
router.get('/dashboard/health', (req, res) => {
  try {
    const health = getSystemHealth();
    res.json(health);
  } catch (error) {
    console.error('[仪表盘] 获取系统健康失败:', error);
    res.status(500).json({ error: '获取健康状态失败', details: error.message });
  }
});

/** GET /api/knowledge/dashboard/summary — 获取仪表盘汇总数据 */
router.get('/dashboard/summary', (req, res) => {
  try {
    const summary = getDashboardSummary();
    res.json(summary);
  } catch (error) {
    console.error('[仪表盘] 获取汇总数据失败:', error);
    res.status(500).json({ error: '获取汇总数据失败', details: error.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  文件上传 API
// ════════════════════════════════════════════════════════════════

/** POST /api/knowledge/upload — 上传并解析文件 */
router.post('/upload', upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '没有上传文件' });
    }

    const results = [];
    const { targetFile = 'uploaded_kb.json', autoImport = 'false' } = req.body;
    const shouldAutoImport = autoImport === 'true';

    for (const file of req.files) {
      const filePath = path.join(UPLOADS_DIR, file.filename);
      const parseResult = await parseFile(filePath);

      if (parseResult.success) {
        const fileInfo = {
          originalName: file.originalname,
          savedName: file.filename,
          size: file.size,
          type: file.mimetype,
          parseResult: {
            textLength: parseResult.text?.length || 0,
            chunkCount: parseResult.chunks?.length || 0,
            metadata: parseResult.metadata
          }
        };

        // 如果启自动导入，将解析的内容添加到知识库
        if (shouldAutoImport && parseResult.text) {
          const chunks = parseResult.chunks || [parseResult.text];
          const importResults = [];

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (chunk.trim().length < 10) continue; // 忽略过短片段

            const newDoc = {
              id: `kb_upload_${Date.now()}_${i}`,
              title: `${path.basename(file.originalname)} - 片段 ${i + 1}`,
              tags: ['uploaded', 'auto-import'],
              content: chunk,
            };

            const filePath = path.join(DB_DIR, targetFile);
            let arr = [];
            if (fs.existsSync(filePath)) {
              arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            }
            arr.push(newDoc);
            fs.writeFileSync(filePath, JSON.stringify(arr, null, 2));

            importResults.push({
              chunkIndex: i,
              id: newDoc.id,
              contentLength: chunk.length
            });
          }

          fileInfo.autoImport = {
            imported: true,
            targetFile,
            chunkCount: importResults.length,
            results: importResults
          };
        }

        results.push({
          success: true,
          ...fileInfo
        });
      } else {
        results.push({
          success: false,
          originalName: file.originalname,
          error: parseResult.error
        });
      }
    }

    res.json({
      message: `处理了 ${results.length} 个文件`,
      results,
      autoImport: shouldAutoImport
    });
  } catch (error) {
    console.error('[文件上传] 处理失败:', error);
    res.status(500).json({ error: '文件处理失败', details: error.message });
  }
});

/** GET /api/knowledge/upload/dependencies — 检查文件解析依赖 */
router.get('/upload/dependencies', (req, res) => {
  try {
    const deps = checkDependencies();
    res.json(deps);
  } catch (error) {
    console.error('[文件上传] 检查依赖失败:', error);
    res.status(500).json({ error: '检查依赖失败', details: error.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  搜索建议 API
// ════════════════════════════════════════════════════════════════

/** GET /api/knowledge/suggest — 搜索建议 */
router.get('/suggest', (req, res) => {
  const { q = '', limit = 5 } = req.query;

  if (!q || q.length < 2) {
    return res.json({ suggestions: [] });
  }

  try {
    const allDocs = loadAllDocs();

    // 简单实现：从文档标题和标签中提取相关建议
    const suggestions = new Set();

    // 1. 匹配标题
    allDocs.forEach(doc => {
      if (doc.title && doc.title.toLowerCase().includes(q.toLowerCase())) {
        // 提取包含查询词的短语
        const titleWords = doc.title.split(/[\s，。]+/);
        titleWords.forEach(word => {
          if (word.toLowerCase().includes(q.toLowerCase()) && word.length > q.length) {
            suggestions.add(word);
          }
        });
      }
    });

    // 2. 匹配标签
    allDocs.forEach(doc => {
      (doc.tags || []).forEach(tag => {
        if (tag.toLowerCase().includes(q.toLowerCase())) {
          suggestions.add(tag);
        }
      });
    });

    // 3. 常见查询建议（简化版）
    const commonSuggestions = [
      '课程价格',
      '老师介绍',
      '学习资料',
      '常见问题',
      '报名流程'
    ];

    commonSuggestions.forEach(suggestion => {
      if (suggestion.toLowerCase().includes(q.toLowerCase())) {
        suggestions.add(suggestion);
      }
    });

    const result = Array.from(suggestions)
      .slice(0, limit)
      .map(text => ({ text, type: 'suggestion' }));

    res.json({ query: q, suggestions: result });
  } catch (error) {
    console.error('[搜索建议] 生成失败:', error);
    res.status(500).json({ error: '生成建议失败', details: error.message });
  }
});

module.exports = { retrieve, formatForPrompt, router };
