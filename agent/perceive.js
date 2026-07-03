/**
 * agent/perceive.js
 * ──────────────────────────────────────────────────────────────────
 *  感知（perceive）步骤独立模块
 *
 *  质量强化点：
 *  1. Prompt 内置 8 条 few-shot examples（覆盖 5 个场景）
 *  2. temperature = 0（要求稳定输出）
 *  3. JSON 解析失败 → 走 heuristic 分类，绝不 fallback 到"闲聊"
 *  4. LLM 与 heuristic 分类不一致时，若 heuristic 强命中（关键词密度高），以 heuristic 为准
 *  5. key_intents / summary 会被下游读取（plan、execute prompt 都引用）
 *
 *  输出结构（与老版一致，保证向后兼容）：
 *    {
 *      scenario: '课程咨询'|'专业问题'|'投诉维权'|'信息查询'|'闲聊',
 *      emotion:  '平静'|'好奇'|'焦虑'|'愤怒'|'满意'|'沮丧'|'开心',
 *      emotion_intensity: 1-10,
 *      identity: '家长'|'学生'|'未知',
 *      urgency:  '高'|'中'|'低',
 *      key_intents: string[],
 *      summary:  string,
 *      _source:  'llm' | 'heuristic' | 'llm+heuristic'  ← 便于日志排查
 *    }
 * ──────────────────────────────────────────────────────────────────
 */

const { chat, safeParseJSON } = require('../services/llm-client');

// ──────────────────────────────────────────────────────────────────
//  Heuristic 关键词库（用于兜底 + 校验 LLM 输出）
// ──────────────────────────────────────────────────────────────────
const KEYWORDS = {
  投诉维权: [
    '投诉', '退款', '维权', '退费', '骗', '欺骗', '虚假', '误导',
    '不退', '骗人', '假的', '曝光', '差评', '举报', '监管',
    '不合理', '态度差', '要求退', '要退', '我要退',
  ],
  信息查询: [
    '搜索', '检索', '查一下', '查一查', '查询', '搜一下',
    '最新', '今天', '今日', '最近', '近期', '实时', '目前', '当前',
    '新闻', '动态', '政策', '排行', '排名', '股价', '汇率',
    '什么时候', '几号', '哪一天', '现在几点',
  ],
  课程咨询: [
    '课程', '报名', '价格', '学费', '多少钱', '几钱', '多贵',
    '精英班', '提升班', '基础班', '强化班', '单科',
    '试听', '优惠', '折扣', '套餐', '一对一', '小班', '大班',
    '开课', '什么时候上', '排课',
  ],
  专业问题: [
    '怎么解', '怎么做', '这道题', '题目', '例题', '解题', '解答',
    '公式', '定理', '推导', '证明', '化简', '因式分解',
    '数学', '物理', '化学', '英语', '语文', '生物', '历史', '地理',
    '语法', '词汇', '作文', '阅读理解',
  ],
};

const EMOTION_KEYWORDS = {
  愤怒:  ['气死', '生气', '愤怒', '恶心', '烦死', '欺骗', '骗', '骗子', '差评', '投诉', '妈的', '滚', '垃圾', '无语', '过分'],
  焦虑:  ['焦虑', '担心', '急', '着急', '怎么办', '不知道', '很怕', '害怕', '来不及', '快要', '紧张', '慌'],
  沮丧:  ['沮丧', '难过', '伤心', '哭', '不行', '没用', '放弃', '无助', '崩溃'],
  开心:  ['开心', '高兴', '哈哈', '感谢', '谢谢', '太好了', '喜欢', '棒'],
  满意:  ['满意', '不错', '还行', '可以的', '专业', '靠谱'],
  好奇:  ['为什么', '怎么', '如何', '什么是', '想问', '请问', '想了解'],
};

const IDENTITY_KEYWORDS = {
  家长: ['孩子', '我家', '娃', '儿子', '女儿', '孩儿', '家长', '小朋友', '小孩'],
  学生: ['我自己', '我是学生', '我读', '我在上', '我要考', '我数学', '我英语', '我物理'],
};

const SCENARIOS = ['投诉维权', '信息查询', '课程咨询', '专业问题', '闲聊'];
const EMOTIONS  = ['平静', '好奇', '焦虑', '愤怒', '满意', '沮丧', '开心'];

/** 关键词打分：命中数 + 命中密度 */
function scoreKeywords(text, dict) {
  const scores = {};
  const lower = String(text || '');
  for (const [label, kws] of Object.entries(dict)) {
    let hits = 0;
    for (const kw of kws) {
      if (lower.includes(kw)) hits++;
    }
    if (hits > 0) scores[label] = hits;
  }
  return scores;
}

/** 纯启发式感知（LLM 挂时的兜底） */
function heuristicPerceive(message, fallbackIdentity = 'parent') {
  const msg = String(message || '');

  // 场景：按优先级
  const scScores = scoreKeywords(msg, KEYWORDS);
  const scenario =
    (scScores['投诉维权'] >= 1 && '投诉维权') ||
    (scScores['信息查询'] >= 1 && '信息查询') ||
    (scScores['课程咨询'] >= 1 && '课程咨询') ||
    (scScores['专业问题'] >= 1 && '专业问题') ||
    '闲聊';

  // 情绪
  const emoScores = scoreKeywords(msg, EMOTION_KEYWORDS);
  let emotion = '平静', intensity = 3;
  const emoEntries = Object.entries(emoScores).sort((a, b) => b[1] - a[1]);
  if (emoEntries.length) {
    emotion = emoEntries[0][0];
    intensity = Math.min(10, 4 + emoEntries[0][1] * 2);
  }
  // 感叹号 & 重复标点 加强度（累计计数，不要求连续）
  const exclCount = (msg.match(/[！!]/g) || []).length;
  const questCount = (msg.match(/[？?]/g) || []).length;
  if (exclCount >= 2) intensity = Math.min(10, intensity + 2);
  else if (exclCount === 1) intensity = Math.min(10, intensity + 1);
  if (questCount >= 3) intensity = Math.min(10, intensity + 1);

  // 场景强关联：投诉必然情绪激烈；愤怒场景优先
  if (scenario === '投诉维权') {
    intensity = Math.max(intensity, 6);
    if ((scScores['投诉维权'] || 0) >= 2) intensity = Math.max(intensity, 7);
    if (emotion === '平静' || emotion === '好奇') emotion = '愤怒';
  }

  // 身份
  const idScores = scoreKeywords(msg, IDENTITY_KEYWORDS);
  let identity = fallbackIdentity === 'parent' ? '家长' : '学生';
  if (idScores['家长'] > idScores['学生']) identity = '家长';
  else if (idScores['学生'] > idScores['家长']) identity = '学生';

  // 紧急度
  const urgency =
    (scenario === '投诉维权' || intensity >= 8) ? '高'
    : (scenario === '课程咨询' || scenario === '信息查询') ? '中'
    : '低';

  return {
    scenario,
    emotion,
    emotion_intensity: intensity,
    identity,
    urgency,
    key_intents: [],
    summary: msg.slice(0, 40),
    _source: 'heuristic',
  };
}

// ──────────────────────────────────────────────────────────────────
//  Few-shot 示例（写死在 prompt 里，稳定分类边界）
// ──────────────────────────────────────────────────────────────────
const FEWSHOT = `
### 示例
用户："你们精英班多少钱？跟提升班比哪个好？"
输出：{"scenario":"课程咨询","emotion":"好奇","emotion_intensity":4,"identity":"家长","urgency":"中","key_intents":["询问精英班价格","精英班与提升班对比"],"summary":"家长比较精英班和提升班的价格与差异"}

用户："我上周报名了但一直没排课！要退钱！"
输出：{"scenario":"投诉维权","emotion":"愤怒","emotion_intensity":8,"identity":"家长","urgency":"高","key_intents":["投诉未排课","要求退款"],"summary":"家长报名后未排课，情绪激动要求退款"}

用户："请帮我搜一下今年高考数学难度评价"
输出：{"scenario":"信息查询","emotion":"好奇","emotion_intensity":3,"identity":"未知","urgency":"中","key_intents":["查询今年高考数学难度评价"],"summary":"用户希望查询今年高考数学难度的最新评价"}

用户："这道题 x²-5x+6=0 怎么解？"
输出：{"scenario":"专业问题","emotion":"好奇","emotion_intensity":3,"identity":"学生","urgency":"低","key_intents":["求解一元二次方程"],"summary":"学生询问一元二次方程 x²-5x+6=0 的解法"}

用户："哈哈你还挺可爱的"
输出：{"scenario":"闲聊","emotion":"开心","emotion_intensity":5,"identity":"未知","urgency":"低","key_intents":["闲聊调侃"],"summary":"用户调侃 AI 助手"}

用户："我家孩子高一物理很差，想问问有没有针对性的方案"
输出：{"scenario":"课程咨询","emotion":"焦虑","emotion_intensity":6,"identity":"家长","urgency":"中","key_intents":["高一物理薄弱","寻求针对性课程"],"summary":"家长因孩子高一物理薄弱寻求针对性辅导方案"}

用户："快到期了还没安排老师，能不能今天给个答复！"
输出：{"scenario":"投诉维权","emotion":"焦虑","emotion_intensity":9,"identity":"家长","urgency":"高","key_intents":["排课延误","要求今日答复"],"summary":"家长因排课延误情绪焦虑，要求今日给出明确答复"}

用户："今日汇率美元人民币多少？"
输出：{"scenario":"信息查询","emotion":"平静","emotion_intensity":2,"identity":"未知","urgency":"中","key_intents":["查询今日美元人民币汇率"],"summary":"用户询问今日美元兑人民币汇率"}
`;

// ──────────────────────────────────────────────────────────────────
//  主入口
// ──────────────────────────────────────────────────────────────────
async function perceive({ message, summary, history, identity, traceId, log }) {
  const heuristic = heuristicPerceive(message, identity);

  // 取最近 3 轮对话（最多 6 条）作为上下文，让短回复能被正确归类
  const recent = Array.isArray(history) ? history.slice(-6) : [];
  const lastAssistant = [...recent].reverse().find(m => m.role === 'assistant');
  const historyBlock = recent.length
    ? recent.map(m => `${m.role === 'user' ? '用户' : 'AI'}：${String(m.content || '').slice(0, 120)}`).join('\n')
    : '(无历史)';

  const prompt = `你是"用户意图 + 情绪"分析器，为一个教育行业 AI 助手服务。请严格按 JSON 输出，只输出 JSON，不要任何多余文字。

【场景枚举】投诉维权 / 信息查询 / 课程咨询 / 专业问题 / 闲聊
【情绪枚举】平静 / 好奇 / 焦虑 / 愤怒 / 满意 / 沮丧 / 开心
【身份枚举】家长 / 学生 / 未知
【紧急度枚举】高 / 中 / 低

判定要点：
- "投诉维权"：出现"投诉/退款/退费/骗/维权/差评/曝光"等词，或用户明确表达对服务不满
- "信息查询"：需要联网获取的时效信息（新闻/政策/最新/今天/汇率/排行 等）
- "课程咨询"：涉及课程/价格/报名/试听/开课时间/教师安排
- "专业问题"：具体学科问题、题目、公式、语法
- "闲聊"：以上都不是且用户没有明确诉求
- 情绪 intensity 1-10：多个感叹号/激烈用词 → ≥7；平静事实性问题 → 2-4

⚠️ 上下文连贯性（重要）：
- 用户消息可能是对上一轮 AI 提问的简短回应或补充。**必须结合下面的对话历史判断场景**，不要孤立地看最新消息。
- 例：AI 上一句在聊课程并问"想了解强基计划方案吗"，用户答"强基计划"——这是**延续课程咨询**，不是"信息查询"。
- 只有当用户明确要查时效性/外部信息（最新政策、今天的数据等）时才判"信息查询"；对上一轮问题的作答一般延续上一轮场景。

${FEWSHOT}

### 待分析
当前对话摘要：${summary || '(无)'}
最近对话历史（旧→新）：
${historyBlock}
${lastAssistant ? `（注意：AI 上一句是"${String(lastAssistant.content).slice(0, 60)}"，用户最新消息很可能是在回应它）` : ''}
前端传入身份：${identity === 'parent' ? '家长' : '学生'}（可被内容覆盖）
用户最新消息：${message}

请输出严格 JSON（含所有字段）：`;

  let llmObj = null;
  try {
    const { content } = await chat({
      step: 'perceive',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      maxTokens: 400,
      traceId, log,
    });
    llmObj = safeParseJSON(content, null);
  } catch (err) {
    log?.warn('perceive.llm_fail', { traceId, msg: err.message?.slice(0, 200), errType: err.errType });
  }

  // ── LLM 失败：完全走 heuristic
  if (!llmObj || typeof llmObj !== 'object' || !llmObj.scenario) {
    log?.warn('perceive.heuristic_fallback', { traceId, reason: llmObj ? 'invalid_json' : 'llm_error' });
    return heuristic;
  }

  // ── LLM 成功：字段校验 + heuristic 交叉修正
  const result = {
    scenario:          SCENARIOS.includes(llmObj.scenario) ? llmObj.scenario : heuristic.scenario,
    emotion:           EMOTIONS.includes(llmObj.emotion) ? llmObj.emotion : heuristic.emotion,
    emotion_intensity: clampInt(llmObj.emotion_intensity, 1, 10, heuristic.emotion_intensity),
    identity:          ['家长', '学生', '未知'].includes(llmObj.identity) ? llmObj.identity : heuristic.identity,
    urgency:           ['高', '中', '低'].includes(llmObj.urgency) ? llmObj.urgency : heuristic.urgency,
    key_intents:       Array.isArray(llmObj.key_intents) ? llmObj.key_intents.slice(0, 5) : [],
    summary:           typeof llmObj.summary === 'string' ? llmObj.summary.slice(0, 120) : heuristic.summary,
    _source:           'llm',
  };

  // ── 关键 override：heuristic 强命中"投诉维权"时，LLM 若判为其他，改为投诉维权
  //    因为漏判投诉的成本远高于误判
  const scScores = scoreKeywords(message, KEYWORDS);
  if ((scScores['投诉维权'] || 0) >= 2 && result.scenario !== '投诉维权') {
    log?.info('perceive.override_to_complaint', { traceId, orig: result.scenario, hits: scScores['投诉维权'] });
    result.scenario = '投诉维权';
    result.urgency  = '高';
    result._source  = 'llm+heuristic';
  }

  // ── 一致性检查：情绪强度 ≥ 8 → 紧急度至少中
  if (result.emotion_intensity >= 8 && result.urgency === '低') {
    result.urgency = '中';
  }

  // ── 上下文守卫：短回复 + 无搜索关键词 + 有上文 → 不该判"信息查询"（避免误触发联网）
  //    典型：AI 上一句在聊课程并提问，用户答"强基计划"，应延续上文而非当作新的检索请求
  const hasSearchKw = /搜索|检索|查一下|查一查|查询|搜一下|最新|今天|今日|最近|近期|实时|目前|当前|新闻|动态|政策|排行|股价|汇率|什么时候|几号/.test(message);
  if (result.scenario === '信息查询' && !hasSearchKw && String(message).trim().length <= 8 && recent.length > 0) {
    // 结合最近历史内容猜测延续场景（排除"信息查询"自身）
    const ctxText = recent.map(m => m.content).join(' ');
    const ctxScores = scoreKeywords(ctxText, KEYWORDS);
    delete ctxScores['信息查询'];
    const best = Object.entries(ctxScores).sort((a, b) => b[1] - a[1])[0];
    const demoted = best ? best[0] : '课程咨询';   // 教育顾问场景下最稳的兜底
    log?.info('perceive.demote_infoquery_by_context', { traceId, message, from: '信息查询', to: demoted });
    result.scenario = demoted;
    result._source += '+ctx_guard';
  }

  return result;
}

function clampInt(v, min, max, defaultV) {
  const n = Number(v);
  if (!Number.isFinite(n)) return defaultV;
  return Math.max(min, Math.min(max, Math.round(n)));
}

module.exports = { perceive, heuristicPerceive, scoreKeywords, KEYWORDS };
