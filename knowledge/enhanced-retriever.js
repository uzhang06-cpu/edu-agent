/**
 * enhanced-retriever.js
 * ──────────────────────────────────────────────────────────────────
 * 增强检索引擎：TF-IDF + 关键词扩展 + 混合检索
 *
 * 功能：
 * 1. TF-IDF 向量相似度计算
 * 2. 查询扩展（同义词/相关词）
 * 3. 混合检索（结合关键词匹配和向量相似度）
 * 4. 缓存机制提升性能
 *
 * 使用 natural 库进行 TF-IDF 计算
 * ──────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');
const natural = require('natural');

const DB_DIR = path.join(__dirname, 'db');
const CACHE_DIR = path.join(__dirname, '.cache');
const TFIDF_CACHE_FILE = path.join(CACHE_DIR, 'tfidf_cache.json');

// 确保缓存目录存在
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// ── 中文分词增强（使用自然语言处理库）─────────────────────────────
function tokenizeChinese(text) {
  // 简单分词：按字符和标点分割，过滤停用词
  const stopWords = new Set(['的', '了', '在', '是', '我', '有', '和', '就',
    '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要',
    '去', '你', '会', '着', '没有', '看', '好', '自己', '这']);

  return text
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ')  // 保留中文、英文、数字
    .split(/\s+/)
    .filter(token => token.length >= 2 && !stopWords.has(token));
}

// ── 加载和预处理文档 ──────────────────────────────────────────────
function loadAndPreprocessDocs() {
  let docs = [];
  const files = fs.readdirSync(DB_DIR).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(DB_DIR, file), 'utf8'));
      const fileDocs = raw.map(d => ({
        id: d.id,
        title: d.title || '',
        tags: d.tags || [],
        content: d.content || '',
        source: file,
        // 预处理文本用于 TF-IDF
        processedText: `${d.title} ${(d.tags || []).join(' ')} ${d.content}`
          .toLowerCase()
          .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ')
      }));
      docs = docs.concat(fileDocs);
    } catch (e) {
      console.error(`[增强检索] 加载 ${file} 失败:`, e.message);
    }
  }

  return docs;
}

// ── 构建 TF-IDF 模型（带缓存）─────────────────────────────────────
function buildTfidfModel(docs) {
  // 检查缓存
  if (fs.existsSync(TFIDF_CACHE_FILE)) {
    try {
      const cache = JSON.parse(fs.readFileSync(TFIDF_CACHE_FILE, 'utf8'));
      const docsHash = docs.map(d => d.id).sort().join('|');
      if (cache.docsHash === docsHash) {
        console.log('[增强检索] 从缓存加载 TF-IDF 模型');
        return natural.TfIdf.restore(cache.model);
      }
    } catch (e) {
      console.warn('[增强检索] 缓存加载失败，重新构建:', e.message);
    }
  }

  console.log('[增强检索] 构建 TF-IDF 模型...');
  const tfidf = new natural.TfIdf();

  // 添加文档到 TF-IDF 模型
  docs.forEach(doc => {
    const tokens = tokenizeChinese(doc.processedText);
    tfidf.addDocument(tokens.join(' '), doc.id);
  });

  // 保存缓存
  const docsHash = docs.map(d => d.id).sort().join('|');
  const cache = {
    docsHash,
    model: tfidf.toJSON()
  };

  fs.writeFileSync(TFIDF_CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`[增强检索] TF-IDF 模型构建完成，文档数: ${docs.length}`);

  return tfidf;
}

// ── 查询扩展（简单同义词/相关词）───────────────────────────────────
function expandQuery(query) {
  // 简单的查询扩展：添加常见同义词
  const synonymMap = {
    '课程': ['课', '班级', '教学', '学习'],
    '价格': ['费用', '价钱', '收费', '学费'],
    '老师': ['教师', '导师', '教授', '教员'],
    '学生': ['学员', '学子', '学习者'],
    '问题': ['疑问', '难题', '困惑', '麻烦'],
    '帮助': ['协助', '支援', '帮忙', '支持'],
    '时间': ['时长', '期限', '日程', '安排'],
    '内容': ['教材', '资料', '材料', '知识点']
  };

  const tokens = tokenizeChinese(query);
  const expandedTokens = [...tokens];

  tokens.forEach(token => {
    if (synonymMap[token]) {
      expandedTokens.push(...synonymMap[token]);
    }
  });

  return [...new Set(expandedTokens)]; // 去重
}

// ── 混合检索算法 ──────────────────────────────────────────────────
function hybridRetrieve(query, topK = 5, options = {}) {
  const {
    useTfidf = true,
    useKeyword = true,
    tfidfWeight = 0.7,
    keywordWeight = 0.3,
    minScore = 0.1
  } = options;

  const docs = loadAndPreprocessDocs();
  if (docs.length === 0) {
    return [];
  }

  const results = [];
  const queryTokens = tokenizeChinese(query);
  const expandedTokens = expandQuery(query);

  // 1. 关键词匹配分数
  const keywordScores = {};
  if (useKeyword) {
    docs.forEach(doc => {
      let score = 0;
      const docText = doc.processedText;

      // 标题和标签权重更高
      const titleTags = `${doc.title} ${doc.tags.join(' ')}`.toLowerCase();

      queryTokens.forEach(token => {
        // 在标题/标签中出现
        if (titleTags.includes(token)) {
          score += 3;
        }
        // 在内容中出现
        const contentMatches = (docText.match(new RegExp(token, 'g')) || []).length;
        score += contentMatches;
      });

      // 归一化
      const maxPossible = queryTokens.length * 3 + queryTokens.length * 10; // 估算最大值
      keywordScores[doc.id] = score / Math.max(maxPossible, 1);
    });
  }

  // 2. TF-IDF 相似度分数
  const tfidfScores = {};
  if (useTfidf && docs.length > 0) {
    try {
      const tfidf = buildTfidfModel(docs);
      const queryText = expandedTokens.join(' ');

      docs.forEach(doc => {
        const similarities = [];
        tfidf.tfidfs(queryText, (i, measure) => {
          if (tfidf.documents[i] === doc.id) {
            similarities.push(measure);
          }
        });

        // 取最高相似度
        tfidfScores[doc.id] = similarities.length > 0 ? Math.max(...similarities) : 0;
      });

      // 归一化 TF-IDF 分数到 0-1 范围
      const maxTfidf = Math.max(...Object.values(tfidfScores).filter(v => !isNaN(v)));
      if (maxTfidf > 0) {
        Object.keys(tfidfScores).forEach(id => {
          tfidfScores[id] = tfidfScores[id] / maxTfidf;
        });
      }
    } catch (e) {
      console.error('[增强检索] TF-IDF 计算失败:', e.message);
      // 回退到关键词检索
      Object.keys(keywordScores).forEach(id => {
        tfidfScores[id] = keywordScores[id];
      });
    }
  }

  // 3. 混合分数计算
  docs.forEach(doc => {
    const keywordScore = keywordScores[doc.id] || 0;
    const tfidfScore = tfidfScores[doc.id] || 0;

    let finalScore = 0;
    if (useTfidf && useKeyword) {
      finalScore = (tfidfScore * tfidfWeight) + (keywordScore * keywordWeight);
    } else if (useTfidf) {
      finalScore = tfidfScore;
    } else {
      finalScore = keywordScore;
    }

    if (finalScore >= minScore) {
      results.push({
        id: doc.id,
        title: doc.title,
        content: doc.content,
        tags: doc.tags,
        source: doc.source,
        score: Math.round(finalScore * 100) / 100,
        keywordScore: Math.round(keywordScore * 100) / 100,
        tfidfScore: Math.round(tfidfScore * 100) / 100
      });
    }
  });

  // 按分数排序并返回 topK
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ── 批量检索（用于测试）───────────────────────────────────────────
function batchRetrieve(queries, topK = 3) {
  return queries.map(query => ({
    query,
    results: hybridRetrieve(query, topK)
  }));
}

// ── 清除缓存 ──────────────────────────────────────────────────────
function clearCache() {
  if (fs.existsSync(TFIDF_CACHE_FILE)) {
    fs.unlinkSync(TFIDF_CACHE_FILE);
    console.log('[增强检索] 缓存已清除');
  }
}

module.exports = {
  tokenizeChinese,
  loadAndPreprocessDocs,
  buildTfidfModel,
  expandQuery,
  hybridRetrieve,
  batchRetrieve,
  clearCache
};