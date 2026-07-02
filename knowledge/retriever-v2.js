/**
 * knowledge/retriever-v2.js
 * ══════════════════════════════════════════════════════════════════
 *  P1-1 RAG 升级版检索器
 *
 *  改进点：
 *    1. 中文分词：bigram + unigram 组合切分，配合停用词过滤
 *    2. BM25 打分（比 TF-IDF 更适合短文档 / 词频截断）
 *    3. 大幅扩充同义词表 & 停用词表（教育行业词典）
 *    4. 常驻内存索引 —— 启动时预建，请求路径零磁盘 IO
 *    5. fs.watch 监听 db 目录，任何 JSON 变更 → 增量重建 + 内存热更
 *    6. 检索结果 field-weight：title × 3 + tags × 2 + content × 1
 *
 *  对外 API 与老版兼容：
 *    retrieve(query, topK, minScore) → [{id, title, content, score, source}]
 * ══════════════════════════════════════════════════════════════════
 */

const fs   = require('fs');
const path = require('path');
const { logger } = require('../services/logger');

const DB_DIR = path.join(__dirname, 'db');
const log = logger.child({ mod: 'retriever-v2' });

// ──────────────────────────────────────────────────────────────────
//  词表（可外部覆盖）
// ──────────────────────────────────────────────────────────────────
const STOPWORDS = new Set([
  '的','了','在','是','我','有','和','就','都','而','及','与','或',
  '不','人','都','一','一个','一些','上','也','很','到','说','要',
  '去','你','会','着','没','没有','看','好','自己','这','那','这个','那个',
  '这些','那些','这样','那样','如何','为什么','什么','怎么','怎样','哪里',
  '哪个','请','请问','问','麻烦','帮','帮我','能否','可以','想','我想','我要',
  '一下','一点','有点','有些','然后','所以','但是','但','而且','因为','由于',
  '呢','吗','啊','哦','嗯','呀','哈','哈哈','唉','哎','嘛',
  '就是','还是','或者','已经','正在','即将','将会','应该','可能','大概',
  '大约','差不多','其实','还','再','又','也','都','很','非常','特别',
  'the','a','an','of','to','in','is','are','was','were','be','been','being',
  'for','on','at','by','with','from','as','it','this','that','these','those',
]);

const SYNONYMS = {
  // 课程/费用
  '课程': ['课', '班级', '教学', '培训', '辅导'],
  '价格': ['费用', '价钱', '收费', '学费', '多少钱', '多少', '收多少'],
  '优惠': ['折扣', '打折', '减免', '促销', '活动', '优惠券'],
  '报名': ['报考', '入学', '注册', '加入'],
  '退款': ['退费', '退钱', '退回', '返还'],
  '试听': ['试课', '体验', '免费课', '公开课'],
  // 教师/学生
  '老师': ['教师', '导师', '教授', '教员', '讲师', '授课老师'],
  '学生': ['学员', '学子', '同学', '孩子', '娃'],
  '家长': ['父母', '爸妈', '妈妈', '爸爸'],
  // 学科
  '数学': ['数', '数理'],
  '语文': ['文', '国语'],
  '英语': ['英', '外语', 'English'],
  '物理': ['物'],
  '化学': ['化'],
  '生物': ['生'],
  // 学习相关
  '学习': ['温习', '复习', '预习', '学'],
  '成绩': ['分数', '排名', '名次', '考试成绩'],
  '进步': ['提升', '提高', '增长'],
  '薄弱': ['差', '弱', '不好', '基础差'],
  // 时间
  '时间': ['时长', '期限', '日程', '安排'],
  '课时': ['节课', '节', '小时', '课节'],
  // 服务
  '答疑': ['答问', '解答', '咨询', '解疑'],
  '直播': ['在线', '实时'],
  '录播': ['回放', '录制'],
  '一对一': ['1对1', '单独', '专属'],
  '小班': ['小班课', '小组课'],
  '大班': ['大班课'],
  // 情绪相关
  '着急': ['急', '紧急', '慌张'],
  '担心': ['忧虑', '焦虑', '不安'],
};

/** 建反向索引：token → 标准词（去重展开） */
function buildSynonymIndex() {
  const idx = {};
  for (const [canonical, alts] of Object.entries(SYNONYMS)) {
    idx[canonical] = canonical;
    for (const alt of alts) idx[alt] = canonical;
  }
  return idx;
}
const SYN_INDEX = buildSynonymIndex();

/** 展开同义词：返回原 tokens + 同义标准词 */
function expandTokens(tokens) {
  const out = new Set(tokens);
  for (const t of tokens) {
    if (SYN_INDEX[t] && SYN_INDEX[t] !== t) out.add(SYN_INDEX[t]);
  }
  return Array.from(out);
}

// ──────────────────────────────────────────────────────────────────
//  中文分词：bigram + unigram + 拉丁词
//  例："高一数学老师" → ['高一','一数','数学','学老','老师','高','数学','老师']
//  好处：不依赖 nodejieba（Windows 编译坑），中文短语和长词都能命中
// ──────────────────────────────────────────────────────────────────
function tokenize(text) {
  if (!text) return [];
  const s = String(text).toLowerCase();
  const tokens = new Set();

  // 拉丁词/数字：整块
  const latin = s.match(/[a-z0-9]+/g) || [];
  for (const w of latin) if (w.length >= 2 && !STOPWORDS.has(w)) tokens.add(w);

  // 中文：逐字扫描
  const cjk = s.replace(/[^一-龥]+/g, ' ');
  const runs = cjk.split(/\s+/).filter(Boolean);

  for (const run of runs) {
    // Unigram（单字）—— 用于兜底
    for (const ch of run) {
      if (!STOPWORDS.has(ch)) tokens.add(ch);
    }
    // Bigram（相邻两字）—— 主力
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2);
      if (!STOPWORDS.has(bg)) tokens.add(bg);
    }
    // Trigram（三字）—— 命中"数学班" "精英班"
    for (let i = 0; i < run.length - 2; i++) {
      const tg = run.slice(i, i + 3);
      if (!STOPWORDS.has(tg)) tokens.add(tg);
    }
  }

  return Array.from(tokens);
}

// ──────────────────────────────────────────────────────────────────
//  BM25 索引
//  公式：score(D, Q) = Σ IDF(qi) · f(qi,D)·(k1+1) / (f(qi,D) + k1·(1-b+b·|D|/avgdl))
// ──────────────────────────────────────────────────────────────────
const K1 = 1.5;
const B  = 0.75;

class BM25Index {
  constructor() {
    this.docs = [];           // [{id, title, content, tags, source, tokens, len, tokFreq}]
    this.df = new Map();      // token → 出现在多少个文档
    this.avgdl = 0;
    this.N = 0;
  }

  addDoc(doc) {
    // 权重字段：title × 3, tags × 2, content × 1
    const stream = [
      ...Array(3).fill(doc.title || ''),
      ...Array(2).fill((doc.tags || []).join(' ')),
      doc.content || '',
    ].join(' ');

    const tokens = tokenize(stream);
    const tokFreq = new Map();
    for (const t of tokens) tokFreq.set(t, (tokFreq.get(t) || 0) + 1);

    const entry = {
      id:      doc.id,
      title:   doc.title || '',
      content: doc.content || '',
      tags:    doc.tags || [],
      source:  doc.source,
      tokens,
      len:     tokens.length,
      tokFreq,
    };
    this.docs.push(entry);
    for (const t of tokFreq.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
  }

  finalize() {
    this.N = this.docs.length;
    if (!this.N) { this.avgdl = 0; return; }
    let total = 0;
    for (const d of this.docs) total += d.len;
    this.avgdl = total / this.N;
  }

  idf(term) {
    const df = this.df.get(term) || 0;
    // BM25 IDF 平滑：max(0.01, log((N-df+0.5)/(df+0.5)+1))
    return Math.max(0.01, Math.log((this.N - df + 0.5) / (df + 0.5) + 1));
  }

  score(doc, queryTokens) {
    let s = 0;
    for (const q of queryTokens) {
      const f = doc.tokFreq.get(q) || 0;
      if (!f) continue;
      const idf = this.idf(q);
      const norm = 1 - B + B * (doc.len / (this.avgdl || 1));
      s += idf * (f * (K1 + 1)) / (f + K1 * norm);
    }
    return s;
  }

  search(query, topK = 5, minScore = 0.5) {
    if (!this.N) return [];
    const raw = tokenize(query);
    const q = expandTokens(raw);
    const scored = this.docs.map(d => ({ doc: d, score: this.score(d, q) }));
    scored.sort((a, b) => b.score - a.score);
    // BM25 分数范围（0.5-5+），旧调用方可能传 0.15（TF-IDF 尺度）；
    // 内部至少要求 0.5，避免大量弱相关命中
    const effective = Math.max(minScore, 0.5);
    return scored
      .filter(x => x.score >= effective)
      .slice(0, topK)
      .map(x => ({
        id:      x.doc.id,
        title:   x.doc.title,
        content: x.doc.content,
        source:  x.doc.source,
        score:   Math.round(x.score * 100) / 100,
      }));
  }

  stats() {
    return { N: this.N, avgdl: Math.round(this.avgdl), vocab: this.df.size };
  }
}

// ──────────────────────────────────────────────────────────────────
//  索引：单例 + 常驻内存 + 增量重建
// ──────────────────────────────────────────────────────────────────
let INDEX = new BM25Index();
let lastBuiltAt = 0;
let watcher = null;
let rebuildTimer = null;

function rebuildIndex() {
  const started = Date.now();
  const next = new BM25Index();
  if (!fs.existsSync(DB_DIR)) {
    INDEX = next; lastBuiltAt = Date.now();
    log.warn('rag.rebuild.no_dir', { dir: DB_DIR });
    return;
  }
  const files = fs.readdirSync(DB_DIR).filter(f => f.endsWith('.json'));
  let docCount = 0;
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(DB_DIR, file), 'utf8');
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) continue;
      for (const d of arr) {
        next.addDoc({ ...d, source: file });
        docCount++;
      }
    } catch (e) {
      log.error('rag.rebuild.file_error', { file, err: e });
    }
  }
  next.finalize();
  INDEX = next;
  lastBuiltAt = Date.now();
  log.info('rag.rebuild.done', {
    duration: Date.now() - started,
    ...INDEX.stats(),
  });
}

function scheduleRebuild(reason) {
  // 300ms 防抖：一次编辑触发多个 fs 事件时只重建一次
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    log.info('rag.rebuild.triggered', { reason });
    rebuildIndex();
  }, 300);
}

function startWatcher() {
  if (watcher) return;
  if (!fs.existsSync(DB_DIR)) return;
  try {
    watcher = fs.watch(DB_DIR, (event, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      scheduleRebuild(`fs.${event}:${filename}`);
    });
    log.info('rag.watch.started', { dir: DB_DIR });
  } catch (e) {
    log.warn('rag.watch.fail', { err: e });
  }
}

// 启动即建索引；watcher 在非测试环境启用
rebuildIndex();
if (process.env.NODE_ENV !== 'test' && !process.env.NO_RAG_WATCH) {
  startWatcher();
}

// ──────────────────────────────────────────────────────────────────
//  对外 API（与老版兼容签名）
// ──────────────────────────────────────────────────────────────────
function retrieve(query, topK = 3, minScore = 0.5) {
  return INDEX.search(query, topK, minScore);
}

function getStats() {
  return { ...INDEX.stats(), lastBuiltAt };
}

function forceRebuild() {
  rebuildIndex();
}

function close() {
  if (watcher) { watcher.close(); watcher = null; }
  clearTimeout(rebuildTimer);
}

module.exports = {
  retrieve, getStats, forceRebuild, close,
  tokenize, expandTokens, BM25Index,
};
