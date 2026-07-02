/**
 * workflows/index.js
 * ──────────────────────────────────────────────────────────────────
 *  工作流注册表（插排式架构）
 *
 *  工作流（Workflow）定义了 Agent 的完整处理流程。
 *  不同场景可切换不同工作流，如：
 *    - 标准5步流（通用）
 *    - 快速回复流（闲聊）
 *    - 投诉处理流（投诉）
 *    - 课程咨询流（销售）
 *
 *  每个 Workflow 结构：
 *  {
 *    name:       string
 *    label:      string
 *    description: string
 *    match:      function(perception) → boolean   // 路由条件
 *    priority:   number                           // 优先级（越高越先检查）
 *    enabled:    boolean
 *    steps:      string[]                         // 步骤序列
 *    systemPrompt: string                         // 基础系统提示词
 *  }
 *
 *  CRUD 路由挂载到 /api/workflows
 * ──────────────────────────────────────────────────────────────────
 */

const { Router } = require('express');
const router = Router();

const WORKFLOWS = [

  // ── 0. 紧急预警流程（最高优先级，多维路由 P1-5）────────────────
  //   触发：情绪强度 ≥ 9 或紧急度 = 高，且非投诉场景
  //   目的：任何高压场景（家长着急要答复、临考焦虑等）都先安抚 + 快速响应
  {
    name: 'emergency_flow',
    label: '紧急响应流程',
    description: '情绪强烈或紧急度高时的快速响应流程，先安抚后办事',
    priority: 110,
    enabled: true,
    match: (p) =>
      p?.scenario !== '投诉维权' &&
      ((p?.emotion_intensity || 0) >= 9 || p?.urgency === '高'),
    steps: ['perceive', 'execute', 'review', 'conclude'],  // 跳过 plan 加速
    systemPrompt: `你是星光教育的资深客户经理，用户当前情绪激动或事情紧急。
应对策略：
- 第一句先明确"我听到您的问题了，马上处理"（不套话，不寒暄）
- 用简短、明确、可执行的语言，禁止模糊承诺
- 如需时间，给出具体时间点（"1 小时内"而非"尽快"）
- 情绪过激时先共情 1 句，再切入解决方案，不超过 3 句话
- 如涉及需要人工处理的事项，直接给出下一步动作（电话、加微、跳转客服）`,
  },

  // ── 1. 投诉处理专属流程 ────────────────────────────────────────
  //   触发：显式投诉场景，或 愤怒/焦虑 × 强度≥7 的其他场景（P1-5）
  {
    name: 'complaint_flow',
    label: '投诉处理流程',
    description: '专为投诉、维权场景设计：额外增加"情绪先行"和"方案承诺"环节；愤怒/焦虑高强度的其他场景也会走此流程',
    priority: 100,
    enabled: true,
    match: (p) => {
      if (p?.scenario === '投诉维权') return true;
      const strong = (p?.emotion_intensity || 0) >= 7;
      return strong && ['愤怒', '焦虑'].includes(p?.emotion);
    },
    steps: ['perceive', 'plan', 'execute', 'review', 'conclude'],
    systemPrompt: `你是星光教育的资深客户成功经理，专门处理敏感投诉。
核心原则：
- 先情绪后事务：任何回复先照顾情绪，再谈解决方案
- 不推卸责任，即使责任未明，先致歉再调查
- 给出明确的时间承诺（"24小时内"、"今天下班前"）
- 适当提供超出预期的补偿（赠课、加速处理等）
- 记录用户核心诉求，回复中体现"我听到了您说的"

当前机构：星光教育在线培训机构
退款政策：7日全退、30日退80%、30日后退50%（90日不退）`,
  },

  // ── 2. 课程咨询销售流程 ────────────────────────────────────────
  {
    name: 'course_inquiry_flow',
    label: '课程咨询流程',
    description: '为课程咨询设计：重点在了解需求→精准推荐→引导成交',
    priority: 90,
    enabled: true,
    match: (perception) => perception?.scenario === '课程咨询',
    steps: ['perceive', 'plan', 'execute', 'review', 'conclude'],
    systemPrompt: `你是星光教育的金牌招生顾问，擅长了解家长/学生需求并精准推荐课程。
核心原则：
- 先了解需求（年级？薄弱科目？学习目标？时间安排？）
- 根据需求推荐最适合的套餐（不是最贵的，是最合适的）
- 价值传递：强调师资、方法、效果保障，弱化价格比较
- 消除顾虑：主动提答疑、退款政策等降低决策门槛
- 适度引导行动（试听课、限时优惠）

课程体系：
- 精英班 ¥19800/年（一对一，适合冲刺名校）
- 提升班 ¥9800/年（小班6人，适合稳步提升）
- 基础班 ¥3800/年（录播，适合基础薄弱）
- 单科强化班 ¥2200/学期（针对单科）`,
  },

  // ── 3. 学术辅导流程 ────────────────────────────────────────────
  {
    name: 'academic_flow',
    label: '学术辅导流程',
    description: '专业学科问题：耐心讲解，循序渐进，提供练习',
    priority: 80,
    enabled: true,
    match: (perception) => perception?.scenario === '专业问题',
    steps: ['perceive', 'execute', 'review', 'conclude'],  // 省略plan步骤加速
    systemPrompt: `你是星光教育的学科辅导老师，知识渊博、善于因材施教。
教学原则：
- 先确认理解：弄清楚学生具体卡在哪里
- 循序渐进：从基础概念讲起，不跳步骤
- 多用类比：把抽象的知识具体化、生活化
- 解题要展示思路而不只给答案
- 结尾布置1道练习题巩固（不给答案，让学生思考）

支持学科：数学、语文、英语、物理、化学（初高中）`,
  },

  // ── 4. 快速闲聊流程 ───────────────────────────────────────────
  {
    name: 'casual_chat_flow',
    label: '快速闲聊流程',
    description: '闲聊场景：跳过感知/规划，直接快速回复，保持轻松自然',
    priority: 70,
    enabled: true,
    match: (perception) => perception?.scenario === '闲聊',
    steps: ['execute', 'conclude'],  // 极简2步
    systemPrompt: `你是星光教育的"星小助"，正在和朋友聊天。
风格：
- 极其简短（1-2句话）。
- 有趣、幽默、不打官腔。
- 像发微信一样自然。`,
  },

  // ── 4.5 信息查询流程（联网搜索） ──────────────────────────────
  {
    name: 'info_query_flow',
    label: '信息查询流程',
    description: '时效性/超出本地知识的查询：必须使用 web_search 工具联网获取',
    priority: 85,
    enabled: true,
    match: (perception) => perception?.scenario === '信息查询',
    steps: ['perceive', 'plan', 'execute', 'review', 'conclude'],
    systemPrompt: `你是星光教育的"星小助"。当前用户提出的是【需要联网获取的信息查询】。

绝对禁止：
- 禁止说"我无法检索实时信息""我的知识截止于…""请开启联网搜索功能"等任何回避性表达
- 禁止凭记忆回答时效性问题——必须使用下方 [工具数据] 中 web_search 的结果

回答方式：
- 如果 [工具数据] 含 web_search results 数组：基于其 title/snippet 用中文做简洁小结，结尾以"参考来源："列出 2-3 条最相关条目（"标题 — URL"格式）
- 如果 web_search 失败或无结果：坦诚说明"暂时联网搜索失败了，建议你换更精确的关键词重试，或访问 [相关官方网站] 查证"
- 不要凭空编造 URL；只引用工具数据中真实出现的链接`,
  },

  // ── 5. 标准5步流（兜底通用）────────────────────────────────────
  {
    name: 'standard_5step',
    label: '标准5步流程',
    description: '通用兜底工作流：感知→规划→执行→复盘→定论，适合所有场景',
    priority: 0,
    enabled: true,
    match: () => true,  // 兜底
    steps: ['perceive', 'plan', 'execute', 'review', 'conclude'],
    systemPrompt: `你是星光教育的"星小助"。
你的风格：
- 说话干脆利落，不拖泥带水。
- 像个老练的咨询师，而不是机器人。
- 除非用户要求详细解释，否则默认只说重点。
- 拒绝任何客套话（如"亲爱的用户"、"您好，我是..."），直接回答问题。

机构信息：星光教育，K12在线教育专家，累计服务10万+学生。`,
  },

];

// ════════════════════════════════════════════════════════════════
//  路由选择逻辑
// ════════════════════════════════════════════════════════════════

/** 根据感知结果选择最优工作流。返回 { workflow, reason } 便于日志追踪 */
function selectWorkflow(perception) {
  const candidates = WORKFLOWS
    .filter(w => w.enabled && w.match(perception))
    .sort((a, b) => b.priority - a.priority);
  const workflow = candidates[0] || WORKFLOWS.find(w => w.name === 'standard_5step');
  const reason = candidates.length > 1
    ? `优先命中(其他候选:${candidates.slice(1).map(c => c.name).join(',')})`
    : candidates.length === 1 ? '唯一命中' : '兜底';
  return { workflow, reason };
}

/** 老接口：只返回 workflow（保留向后兼容） */
function selectWorkflowLegacy(perception) {
  return selectWorkflow(perception).workflow;
}

// ════════════════════════════════════════════════════════════════
//  CRUD HTTP 路由 /api/workflows
// ════════════════════════════════════════════════════════════════

router.get('/', (req, res) => {
  res.json(WORKFLOWS.map(({ match, ...rest }) => rest));
});

router.get('/:name', (req, res) => {
  const wf = WORKFLOWS.find(w => w.name === req.params.name);
  if (!wf) return res.status(404).json({ error: '工作流不存在' });
  const { match, ...rest } = wf;
  res.json(rest);
});

router.patch('/:name', (req, res) => {
  const wf = WORKFLOWS.find(w => w.name === req.params.name);
  if (!wf) return res.status(404).json({ error: '工作流不存在' });
  if (typeof req.body.enabled === 'boolean') wf.enabled = req.body.enabled;
  if (req.body.systemPrompt) wf.systemPrompt = req.body.systemPrompt;
  if (req.body.priority !== undefined) wf.priority = req.body.priority;
  res.json({ message: '更新成功', name: wf.name });
});

/** GET /api/workflows/match?scenario=xxx — 预览场景匹配哪个工作流 */
router.get('/utils/match', (req, res) => {
  const fakePerception = {
    scenario: req.query.scenario,
    emotion:  req.query.emotion,
    emotion_intensity: Number(req.query.intensity) || 0,
    urgency:  req.query.urgency,
  };
  const { workflow, reason } = selectWorkflow(fakePerception);
  res.json({
    input:   fakePerception,
    matched: workflow.name,
    label:   workflow.label,
    steps:   workflow.steps,
    reason,
  });
});

module.exports = { WORKFLOWS, selectWorkflow, selectWorkflowLegacy, router };
