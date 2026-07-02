/**
 * tools/index.js
 * ──────────────────────────────────────────────────────────────────
 *  工具注册表（插排式架构）
 *
 *  每个工具的结构：
 *  {
 *    name:        string          // 唯一标识（英文下划线）
 *    label:       string          // 中文名称
 *    description: string          // 用途描述（会注入 LLM 上下文）
 *    params:      object          // 参数定义（JSON Schema 风格）
 *    enabled:     boolean         // 是否启用
 *    execute:     async (args) => any  // 执行函数
 *  }
 *
 *  CRUD 路由挂载到 /api/tools
 * ──────────────────────────────────────────────────────────────────
 */

const { Router } = require('express');
const router = Router();
const dataService = require('../services/data-service');
const { LRU } = require('../services/cache');
const { logger } = require('../services/logger');

// ── 工具结果缓存（P1-3） ─────────────────────────────────────────
//   Key = `${toolName}:${JSON.stringify(args)}`；TTL 见每个工具
const toolCache = new LRU({ max: 500, ttlMs: 15 * 60 * 1000 });

const CACHE_TTL = {
  web_search:       15 * 60 * 1000,  // 15 min（时效搜索）
  get_course_info:  60 * 60 * 1000,  // 1h
  get_teacher_info: 60 * 60 * 1000,
  get_faq:          60 * 60 * 1000,
  get_schedule:     30 * 60 * 1000,
  check_order_status: 60 * 1000,     // 订单状态易变，1 min
  calculate_discount:  0,             // 计算类不缓存
  get_comfort_template: 60 * 60 * 1000,
  plan_learning_path:  60 * 60 * 1000,
};

// ────────────────────────────────────────────────────────────────
//  JSON Schema 定义（P1-2 function calling）
//  每个工具挂 schema 字段；导出 getToolsSchema() 返回 OpenAI 风格
// ────────────────────────────────────────────────────────────────
const SCHEMAS = {
  get_course_info: {
    type: 'object',
    properties: { courseName: { type: 'string', description: '课程名称，如 "精英班"、"提升班"、"基础班"、"单科强化班"' } },
    required: ['courseName'],
  },
  calculate_discount: {
    type: 'object',
    properties: {
      originalPrice: { type: 'number', description: '原价（整数元）' },
      discountType:  { type: 'string', enum: ['nine_fold', 'eight_five_fold', 'coupon_500', 'coupon_1000'], description: '折扣类型' },
    },
    required: ['originalPrice', 'discountType'],
  },
  check_order_status: {
    type: 'object',
    properties: { orderId: { type: 'string', description: '订单号，形如 XG12345...' } },
    required: ['orderId'],
  },
  get_teacher_info: {
    type: 'object',
    properties: { subject: { type: 'string', description: '学科（数学/语文/英语/物理/化学）或教师姓名' } },
    required: ['subject'],
  },
  plan_learning_path: {
    type: 'object',
    properties: {
      subject:      { type: 'string', description: '学科' },
      currentLevel: { type: 'string', enum: ['poor','medium','good'], description: '当前水平' },
      targetScore:  { type: 'number', description: '目标分数（可选）' },
    },
    required: ['subject', 'currentLevel'],
  },
  get_schedule: {
    type: 'object',
    properties: { courseName: { type: 'string', description: '课程名称或学科' } },
    required: ['courseName'],
  },
  get_faq: {
    type: 'object',
    properties: { question: { type: 'string', description: '用户的问题关键词或原句' } },
    required: ['question'],
  },
  get_comfort_template: {
    type: 'object',
    properties: {
      emotion:  { type: 'string', enum: ['angry','anxious','sad','frustrated'], description: '用户负面情绪' },
      scenario: { type: 'string', description: '场景简述' },
    },
    required: ['emotion'],
  },
  web_search: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '精炼的搜索关键词，去掉"请帮我查"等无意义词' },
      num:   { type: 'integer', minimum: 1, maximum: 10, description: '返回结果条数，默认 5' },
    },
    required: ['query'],
  },
};

// ════════════════════════════════════════════════════════════════
//  工具实现
// ════════════════════════════════════════════════════════════════

const TOOLS = [

  // ── 1. 课程信息查询 ────────────────────────────────────────────
  {
    name: 'get_course_info',
    label: '课程信息查询',
    description: '根据课程名称查询详细信息（价格、权益、适合人群）',
    params: { courseName: '课程名称，如"精英班"' },
    enabled: true,
    execute: async ({ courseName }) => {
      const courses = require('../knowledge/db/courses_kb.json');
      const hit = courses.find(c =>
        c.title.includes(courseName) || (c.tags||[]).some(t => courseName.includes(t))
      );
      return hit
        ? { found: true, info: hit.content }
        : { found: false, info: '未找到匹配课程，可推荐用户访问官网或联系客服' };
    }
  },

  // ── 2. 折扣计算器 ──────────────────────────────────────────────
  {
    name: 'calculate_discount',
    label: '折扣与优惠计算',
    description: '计算多课叠加折扣、优惠券后的实际价格',
    params: { originalPrice: '原价（数字）', discountType: '折扣类型：nine_fold/eight_five_fold/coupon_500/coupon_1000' },
    enabled: true,
    execute: async ({ originalPrice, discountType }) => {
      const price = Number(originalPrice);
      const d = dataService.getDiscount(discountType);
      if (!d) return { error: '未知折扣类型' };
      const final = d.rate ? Math.round(price * d.rate) : price - d.sub;
      return { originalPrice: price, discountType: d.label, finalPrice: Math.max(final, 0), saved: price - Math.max(final, 0) };
    }
  },

  // ── 3. 订单状态查询（模拟） ────────────────────────────────────
  {
    name: 'check_order_status',
    label: '订单状态查询',
    description: '根据订单号查询付款/发货/配送状态',
    params: { orderId: '订单号' },
    enabled: true,
    execute: async ({ orderId }) => {
      const order = dataService.getOrder(orderId);
      return order
        ? { found: true, orderId, ...order }
        : { found: false, message: '未查到该订单，请确认订单号或联系客服 400-888-XXXX' };
    }
  },

  // ── 4. 教师信息查询 ────────────────────────────────────────────
  {
    name: 'get_teacher_info',
    label: '教师信息查询',
    description: '查询特定学科或特定姓名的老师信息',
    params: { subject: '学科（如"数学"、"英语"）或教师姓名' },
    enabled: true,
    execute: async ({ subject }) => {
      const teachers = require('../knowledge/db/teachers_kb.json');
      const hits = teachers.filter(t =>
        t.title.includes(subject) || (t.tags||[]).some(tag => subject.includes(tag) || tag.includes(subject))
      );
      return hits.length
        ? { found: true, teachers: hits.map(t => ({ name: t.title, info: t.content })) }
        : { found: false, message: `暂无${subject}相关教师信息，建议联系班主任了解` };
    }
  },

  // ── 5. 学习路径规划 ────────────────────────────────────────────
  {
    name: 'plan_learning_path',
    label: '学习路径规划',
    description: '根据学生当前成绩和目标，生成个性化学习建议路径',
    params: { subject: '学科', currentLevel: '当前水平：poor/medium/good', targetScore: '目标分数（可选）' },
    enabled: true,
    execute: async ({ subject, currentLevel, targetScore }) => {
      const path = dataService.getLearningPath(currentLevel);

      // 替换模板中的{subject}占位符
      const processedPath = {};
      for (const [key, value] of Object.entries(path)) {
        if (typeof value === 'string') {
          processedPath[key] = value.replace(/\{subject\}/g, subject);
        } else {
          processedPath[key] = value;
        }
      }

      return { subject, currentLevel, targetScore, ...processedPath };
    }
  },

  // ── 6. 排课查询 ────────────────────────────────────────────────
  {
    name: 'get_schedule',
    label: '课程时间表查询',
    description: '查询指定课程的上课时间安排',
    params: { courseName: '课程名称或学科' },
    enabled: true,
    execute: async ({ courseName }) => {
      const allSchedules = dataService.getAllSchedules();
      for (const [subject, schedule] of Object.entries(allSchedules)) {
        if (courseName.includes(subject)) return { subject, schedule };
      }
      return { message: '请联系班主任获取最新排课信息' };
    }
  },

  // ── 7. FAQ 查询 ────────────────────────────────────────────────
  {
    name: 'get_faq',
    label: '常见问题查询',
    description: '查询常见问题的标准回答，如退款、开课流程等',
    params: { question: '用户问题关键词' },
    enabled: true,
    execute: async ({ question }) => {
      const faqs = require('../knowledge/db/faq_kb.json');
      const tokens = question.toLowerCase().split(/[\s，。？！、]+/).filter(t => t.length >= 2);
      let best = null, bestScore = 0;
      for (const faq of faqs) {
        const hay = (faq.title + faq.tags.join(' ')).toLowerCase();
        const score = tokens.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
        if (score > bestScore) { bestScore = score; best = faq; }
      }
      return best && bestScore > 0
        ? { found: true, answer: best.content }
        : { found: false, message: '未找到匹配FAQ，建议转接人工客服' };
    }
  },

  // ── 8. 情感安抚模板 ────────────────────────────────────────────
  {
    name: 'get_comfort_template',
    label: '情感安抚话术',
    description: '为投诉、愤怒、焦虑等负面情绪用户获取安抚话术模板',
    params: { emotion: '用户情绪：angry/anxious/sad/frustrated', scenario: '场景简述' },
    enabled: true,
    execute: async ({ emotion, scenario }) => {
      const template = dataService.getComfortTemplate(emotion);
      return { template, tip: '请先共情，再解决问题' };
    }
  },

  // ── 8. Web 搜索（多引擎兜底） ──────────────────────────────────
  {
    name: 'web_search',
    label: '联网搜索',
    description: '当用户问到时效性强、超出本地知识库范围、需要最新政策/资讯时，使用此工具联网搜索。引擎自动兜底：DuckDuckGo → Tavily → Bing API → Bing 爬虫',
    params: { query: '搜索关键词（精炼，去除"请帮我查"等无意义词）', num: '返回结果数（默认 5）' },
    enabled: true,
    execute: async ({ query, num }) => {
      const { webSearch } = require('../services/web-search');
      return await webSearch({ query, num: Number(num) || 5 });
    }
  },

];

// ════════════════════════════════════════════════════════════════
//  对外接口
// ════════════════════════════════════════════════════════════════

/** 执行工具（供 agent 调用），带 LRU 缓存 */
async function executeTool(name, args) {
  const tool = TOOLS.find(t => t.name === name && t.enabled);
  if (!tool) return { error: `工具 ${name} 不存在或已禁用` };

  const cleanArgs = args || {};
  const cacheKey  = `${name}:${JSON.stringify(cleanArgs)}`;
  const ttl       = CACHE_TTL[name] ?? 0;

  if (ttl > 0) {
    const cached = toolCache.get(cacheKey);
    if (cached !== undefined) {
      logger.info('tool.cache_hit', { name, cacheKey: cacheKey.slice(0, 100) });
      return cached;
    }
  }

  try {
    const result = await tool.execute(cleanArgs);
    if (ttl > 0 && result && !result.error) {
      toolCache.set(cacheKey, result, ttl);
    }
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

/** 老 API：以文本形式列工具描述（保留兼容） */
function getEnabledToolsDesc() {
  return TOOLS
    .filter(t => t.enabled)
    .map(t => `- ${t.name}(${JSON.stringify(t.params)}): ${t.description}`)
    .join('\n');
}

/** P1-2：返回 OpenAI 风格 tools 数组，供 LLM function calling */
function getToolsSchema() {
  return TOOLS
    .filter(t => t.enabled && SCHEMAS[t.name])
    .map(t => ({
      type: 'function',
      function: {
        name:        t.name,
        description: t.description,
        parameters:  SCHEMAS[t.name],
      },
    }));
}

/**
 * P1-3：把工具结果格式化为 LLM 友好的 markdown / 引用格式，
 * 避免直接 JSON.stringify 让模型难以解析
 */
function formatToolResult(name, result) {
  if (!result || result.error) {
    return `[工具 ${name} 失败] ${result?.error || 'unknown error'}`;
  }
  switch (name) {
    case 'web_search': {
      if (!result.results?.length) {
        return `[web_search] engine=${result.engine || '?'}，未找到结果${result.answer ? '\nAI 摘要：' + result.answer : ''}`;
      }
      const lines = [`[web_search] 引擎=${result.engine} · 共 ${result.count} 条`];
      if (result.answer) lines.push(`\n**AI 摘要**：${result.answer}`);
      lines.push('\n**结果列表**：');
      result.results.forEach((r, i) => {
        lines.push(`[${i + 1}] ${r.title || '(无标题)'}\n    ${r.snippet || ''}\n    URL: ${r.url || ''}`);
      });
      return lines.join('\n');
    }
    case 'get_course_info': {
      if (!result.found) return `[课程查询] 未找到，${result.info || ''}`;
      return `[课程信息]\n${result.info}`;
    }
    case 'get_teacher_info': {
      if (!result.found) return `[教师查询] ${result.message}`;
      const lines = [`[教师信息]`];
      for (const t of (result.teachers || [])) {
        lines.push(`- **${t.name}**：${t.info}`);
      }
      return lines.join('\n');
    }
    case 'check_order_status': {
      if (!result.found) return `[订单查询] ${result.message}`;
      return `[订单 ${result.orderId}]\n${JSON.stringify(result, null, 2)}`;
    }
    case 'get_faq': {
      if (!result.found) return `[FAQ] ${result.message}`;
      return `[FAQ 参考答案]\n${result.answer}`;
    }
    case 'calculate_discount': {
      if (result.error) return `[折扣计算] ${result.error}`;
      return `[折扣计算] 原价 ${result.originalPrice}，${result.discountType}，最终 ${result.finalPrice}（省 ${result.saved}）`;
    }
    default:
      return `[${name}]\n${JSON.stringify(result, null, 2)}`;
  }
}

// ════════════════════════════════════════════════════════════════
//  CRUD HTTP 路由 /api/tools
// ════════════════════════════════════════════════════════════════

/** GET /api/tools */
router.get('/', (req, res) => {
  res.json(TOOLS.map(({ execute, ...rest }) => rest));
});

/** GET /api/tools/:name */
router.get('/:name', (req, res) => {
  const tool = TOOLS.find(t => t.name === req.params.name);
  if (!tool) return res.status(404).json({ error: '工具不存在' });
  const { execute, ...rest } = tool;
  res.json(rest);
});

/** PATCH /api/tools/:name — 启用/禁用 */
router.patch('/:name', (req, res) => {
  const tool = TOOLS.find(t => t.name === req.params.name);
  if (!tool) return res.status(404).json({ error: '工具不存在' });
  if (typeof req.body.enabled === 'boolean') tool.enabled = req.body.enabled;
  if (req.body.description) tool.description = req.body.description;
  const { execute, ...rest } = tool;
  res.json({ message: '更新成功', tool: rest });
});

/** POST /api/tools/test — 测试执行某工具 */
router.post('/test', async (req, res) => {
  const { name, args } = req.body;
  const result = await executeTool(name, args);
  res.json({ tool: name, args, result });
});

module.exports = {
  TOOLS,
  executeTool,
  getEnabledToolsDesc,
  getToolsSchema,
  formatToolResult,
  SCHEMAS,
  toolCache,
  router,
};
