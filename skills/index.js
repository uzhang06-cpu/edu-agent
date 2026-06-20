/**
 * skills/index.js
 * ──────────────────────────────────────────────────────────────────
 *  技能注册表（插排式架构）
 *
 *  技能（Skill）是对 Agent Prompt 的增强注入，分两类：
 *    - preprocess(context)  → 在生成回复前修改 system prompt / 注入内容
 *    - postprocess(reply, context) → 在回复生成后处理文本
 *
 *  每个 Skill 结构：
 *  {
 *    name:        string
 *    label:       string
 *    description: string
 *    trigger:     function(context) → boolean  // 决定是否激活
 *    enabled:     boolean
 *    preprocess?: async (context) → { systemAppend?, userAppend? }
 *    postprocess?: async (reply, context) → string
 *  }
 *
 *  CRUD 路由挂载到 /api/skills
 * ──────────────────────────────────────────────────────────────────
 */

const { Router } = require('express');
const router = Router();

const SKILLS = [

  // ── 1. 情绪共情增强 ────────────────────────────────────────────
  {
    name: 'emotion_empathy',
    label: '情绪共情增强',
    description: '当用户情绪强烈（焦虑/愤怒/沮丧）时，自动在系统提示中注入共情话术要求',
    enabled: true,
    trigger: (ctx) => ['愤怒', '焦虑', '沮丧'].includes(ctx.perception?.emotion) && (ctx.perception?.emotion_intensity || 0) >= 5,
    preprocess: async (ctx) => ({
      systemAppend: `
[情绪共情技能已激活]
当前用户情绪：${ctx.perception?.emotion}（强度${ctx.perception?.emotion_intensity}/10）
要求：
1. 回复开头必须先共情，承认用户感受，不要急于给解决方案
2. 使用"我理解""您的感受完全合理"等共情表达
3. 语气温和，避免防御性语言
4. 解决方案部分要分步骤说清楚，让用户感到被重视`
    })
  },

  // ── 2. 课程销售助手 ────────────────────────────────────────────
  {
    name: 'course_sales_assistant',
    label: '课程销售助手',
    description: '当场景为课程咨询时，引导话术技巧：强调价值而非价格，适当制造紧迫感',
    enabled: true,
    trigger: (ctx) => ctx.perception?.scenario === '课程咨询',
    preprocess: async (ctx) => ({
      systemAppend: `
[课程销售技能已激活]
销售策略要点：
1. 先了解用户孩子的年级、薄弱科目、学习目标，再推荐
2. 强调课程的差异化价值（名师、方法论、效果保障）而非单纯价格
3. 对于价格敏感用户，可以提到分期付款或体验课
4. 结尾引导行动：如"需要我帮您安排一节免费试听课吗？"
5. 不要主动降价，但可提示现有优惠活动`
    })
  },

  // ── 3. 投诉处理专家 ────────────────────────────────────────────
  {
    name: 'complaint_handler',
    label: '投诉处理专家',
    description: '投诉场景下的专业处理话术，快速定责、给出解决方案、防止升级',
    enabled: true,
    trigger: (ctx) => ctx.perception?.scenario === '投诉维权',
    preprocess: async (ctx) => ({
      systemAppend: `
[投诉处理技能已激活]
投诉处理标准流程：
1. 致歉 + 共情（不推卸责任，即使责任未明）
2. 确认问题：请用户描述具体情况（订单号、时间、截图等）
3. 给出明确的处理承诺和时间节点（如"我们将在24小时内给您答复"）
4. 如涉及退款：告知退款政策，态度诚恳
5. 提升体验：结尾提供一个额外补偿动作（如赠课、加速处理）
6. 禁止：推卸责任、让用户"再等等"而无具体时间`
    })
  },

  // ── 4. 学术辅导模式 ────────────────────────────────────────────
  {
    name: 'academic_tutor',
    label: '学术辅导模式',
    description: '专业问题场景下，以耐心讲师身份解答，使用例题、类比、循序渐进',
    enabled: true,
    trigger: (ctx) => ctx.perception?.scenario === '专业问题',
    preprocess: async (ctx) => ({
      systemAppend: `
[学术辅导技能已激活]
辅导风格要求：
1. 先判断知识点，给出清晰的概念解释
2. 用生活例子或类比让抽象概念具体化
3. 如果是计算题，展示解题步骤（标注每步意义）
4. 结尾提供1-2道同类练习题（不给答案，鼓励思考）
5. 语气：如朋友般亲切的老师，避免说教感`
    })
  },

  // ── 5. 家长专属话术 ────────────────────────────────────────────
  {
    name: 'parent_mode',
    label: '家长专属话术',
    description: '识别用户身份为家长时，调整措辞更关注孩子成长和家长焦虑',
    enabled: true,
    trigger: (ctx) => ctx.identity === 'parent',
    preprocess: async (ctx) => ({
      systemAppend: `
[家长模式技能已激活]
与家长沟通要点：
1. 理解家长的核心焦虑：孩子成绩、时间投入回报比、孩子是否适应
2. 数据说话：提及成功案例（"我们有学生从120分提升到145分"）
3. 给家长"托底感"：强调跟踪机制、学情报告、随时沟通
4. 尊重家长判断：不要过于强推，给家长自主感`
    })
  },

  // ── 6. 学生专属话术 ────────────────────────────────────────────
  {
    name: 'student_mode',
    label: '学生专属话术',
    description: '识别用户身份为学生时，使用年轻化语言，更加鼓励和活泼',
    enabled: true,
    trigger: (ctx) => ctx.identity === 'student',
    preprocess: async (ctx) => ({
      systemAppend: `
[学生模式技能已激活]
与学生沟通要点：
1. 语言轻松活泼，可以适当用表情（但不过度）
2. 多鼓励，强调"你能行"而非压力
3. 学习建议要具体可执行（每天30分钟，不是"要努力"）
4. 理解学生的压力，不要说教
5. 结合学生感兴趣的话题（游戏、明星等）举例（适度）`
    })
  },

  // ── 7. 简洁模式 ────────────────────────────────────────────────
  {
    name: 'brevity_mode',
    label: '简洁回复模式',
    description: '闲聊场景下，保持回复简短自然，不要长篇大论',
    enabled: true,
    trigger: (ctx) => ctx.perception?.scenario === '闲聊',
    preprocess: async (ctx) => ({
      systemAppend: `[简洁模式] 这是闲聊场景，保持回复简短自然（2-4句话），轻松有趣，像朋友聊天。`
    })
  },

];

// ════════════════════════════════════════════════════════════════
//  对外接口
// ════════════════════════════════════════════════════════════════

/** 获取所有触发的技能，并合并其 preprocess 结果 */
async function applySkills(context) {
  const triggered = SKILLS.filter(s => s.enabled && s.trigger && s.trigger(context));
  let systemAppend = '';
  let userAppend = '';

  for (const skill of triggered) {
    if (skill.preprocess) {
      const result = await skill.preprocess(context);
      if (result.systemAppend) systemAppend += '\n' + result.systemAppend;
      if (result.userAppend)   userAppend   += '\n' + result.userAppend;
    }
  }

  return { systemAppend, userAppend, triggeredSkills: triggered.map(s => s.name) };
}

/** 对回复进行后处理 */
async function postprocessReply(reply, context) {
  let result = reply;
  const triggered = SKILLS.filter(s => s.enabled && s.trigger && s.trigger(context) && s.postprocess);
  for (const skill of triggered) {
    result = await skill.postprocess(result, context);
  }
  return result;
}

// ════════════════════════════════════════════════════════════════
//  CRUD HTTP 路由 /api/skills
// ════════════════════════════════════════════════════════════════

router.get('/', (req, res) => {
  res.json(SKILLS.map(({ trigger, preprocess, postprocess, ...rest }) => rest));
});

router.get('/:name', (req, res) => {
  const skill = SKILLS.find(s => s.name === req.params.name);
  if (!skill) return res.status(404).json({ error: '技能不存在' });
  const { trigger, preprocess, postprocess, ...rest } = skill;
  res.json(rest);
});

router.patch('/:name', (req, res) => {
  const skill = SKILLS.find(s => s.name === req.params.name);
  if (!skill) return res.status(404).json({ error: '技能不存在' });
  if (typeof req.body.enabled === 'boolean') skill.enabled = req.body.enabled;
  if (req.body.description) skill.description = req.body.description;
  res.json({ message: '更新成功', name: skill.name, enabled: skill.enabled });
});

module.exports = { SKILLS, applySkills, postprocessReply, router };
