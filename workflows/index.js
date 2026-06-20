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

  // ── 1. 投诉处理专属流程（优先级最高）────────────────────────────
  {
    name: 'complaint_flow',
    label: '投诉处理流程',
    description: '专为投诉、维权场景设计：额外增加"情绪先行"和"方案承诺"环节',
    priority: 100,
    enabled: true,
    match: (perception) => perception?.scenario === '投诉维权',
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

/** 根据感知结果选择最优工作流 */
function selectWorkflow(perception) {
  const candidates = WORKFLOWS
    .filter(w => w.enabled && w.match(perception))
    .sort((a, b) => b.priority - a.priority);
  return candidates[0] || WORKFLOWS.find(w => w.name === 'standard_5step');
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
  const fakePerception = { scenario: req.query.scenario };
  const wf = selectWorkflow(fakePerception);
  res.json({ scenario: fakePerception.scenario, matched: wf.name, label: wf.label, steps: wf.steps });
});

module.exports = { WORKFLOWS, selectWorkflow, router };
