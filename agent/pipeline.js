/**
 * agent/pipeline.js  (v2)
 * ══════════════════════════════════════════════════════════════════
 *  质量升级版 Agent 流水线
 *
 *  与 v1 的差异：
 *    - P0-1 所有 LLM 调用走 services/llm-client（重试/熔断/trace/token）
 *    - P0-2 execute 步骤支持流式（socket 发 agent_delta）
 *    - P0-3 review 按需触发；summary 异步更新
 *    - P0-4 输出用 services/text-cleaner，不再一刀切删括号
 *    - P0-5 感知走 agent/perceive（few-shot + heuristic 兜底）
 *    - P1-4 review 携带 RAG/工具证据，grounding=false 强制触发 refine
 *    - P1-5 workflow 多维路由（在 workflows/index.js）
 *
 *  Note: P1-2 (function calling) 与 P1-3 (工具结果 & 缓存) 会在 tools 层完成，
 *        此文件里 execute 步骤已经预留了兼容接口。
 * ══════════════════════════════════════════════════════════════════
 */

const config    = require('../config');
const { chat, chatStream, safeParseJSON }  = require('../services/llm-client');
const { logger, newTraceId }                = require('../services/logger');
const { cleanReply }                        = require('../services/text-cleaner');
const { perceive }                          = require('./perceive');
const { retrieve, formatForPrompt }         = require('../knowledge');
const { applySkills }                       = require('../skills');
const { executeTool, getEnabledToolsDesc, getToolsSchema, formatToolResult } = require('../tools');
const { selectWorkflow }                    = require('../workflows');
const { handleError }                       = require('../services/error-service');

// ──────────────────────────────────────────────────────────────────
//  主入口
// ──────────────────────────────────────────────────────────────────
async function runAgent({ socket, message, history, summary, identity }) {
  const traceId = newTraceId();
  const log = logger.child({ traceId });
  log.info('agent.start', { msgLen: message?.length || 0, identity, historyLen: history?.length || 0 });

  const emit = (step, status, label, data) =>
    socket.emit('agent_step', { step, status, label, data, traceId });

  // 状态
  let perception = null;
  let plan       = null;
  let response   = '';
  let review     = null;
  let refined    = false;
  let toolResults = '';
  let ragContext  = '';
  let toolsUsed   = [];

  try {

    // ═════════ STEP 1 · PERCEIVE (P0-5) ═════════
    emit('perceive', 'running', '正在分析用户意图和情绪...');
    const perceiveStarted = Date.now();
    perception = await perceive({ message, summary, identity, traceId, log });
    log.info('perceive.done', {
      duration: Date.now() - perceiveStarted,
      scenario: perception.scenario, emotion: perception.emotion,
      intensity: perception.emotion_intensity, urgency: perception.urgency,
      source: perception._source,
    });
    emit('perceive', 'done',
      `场景:${perception.scenario} · 情绪:${perception.emotion}(${perception.emotion_intensity}/10) · 紧急:${perception.urgency}`
    );

    // ═════════ WORKFLOW 路由 (P1-5) ═════════
    const { workflow, reason: wfReason } = selectWorkflow(perception);
    const steps = workflow.steps;
    log.info('workflow.select', { name: workflow.name, reason: wfReason, steps });

    // ═════════ STEP 2 · PLAN ═════════
    if (steps.includes('plan')) {
      emit('plan', 'running', `工作流[${workflow.label}] 正在制定回复策略...`);
      const planStarted = Date.now();

      const planPrompt = `你是回复策略规划专家。根据用户分析结果制定最优回复策略，输出严格 JSON（不要多余文字）。

感知结果：${JSON.stringify(perception)}
用户核心意图：${(perception.key_intents || []).join('；') || '未识别'}
用户诉求摘要：${perception.summary || '(无)'}
已激活工作流：${workflow.name}（${workflow.description}）

可用工具：
${getEnabledToolsDesc()}

工具选择规则：
- "信息查询"场景 → 必含 web_search
- 消息含"搜索/最新/今天/最近/新闻/汇率" → 必含 web_search
- 询问课程/价格/教师 → 用 get_course_info / get_teacher_info
- 订单相关 → check_order_status
- 情绪安抚场景 → 可加 get_comfort_template
- 闲聊/纯情感 → 工具列表留空

输出 JSON：
{
  "tone": "语气（如：热情关切/专业冷静/共情安慰）",
  "strategy": "回复策略一句话",
  "tools_to_use": ["工具名"],
  "key_points": ["回复必须涵盖的要点"],
  "length": "short|medium|long"
}`;

      try {
        const { content } = await chat({
          step: 'plan',
          messages: [{ role: 'user', content: planPrompt }],
          temperature: 0.2,
          traceId, log,
        });
        plan = safeParseJSON(content, null) || heuristicPlan(perception);
      } catch (err) {
        log.warn('plan.llm_fail', { msg: err.message?.slice(0, 200) });
        plan = heuristicPlan(perception);
      }
      log.info('plan.done', { duration: Date.now() - planStarted, tools: plan.tools_to_use, length: plan.length });
      emit('plan', 'done', `策略:${plan.strategy || '标准回复'} · 语气:${plan.tone || '专业'}`);
    } else {
      plan = heuristicPlan(perception);
    }

    // ═════════ STEP 3 · EXECUTE (P0-2 流式) ═════════
    emit('execute', 'running', '并行执行 RAG 检索和工具调用...');
    const executeStarted = Date.now();

    // ── 3a. 双保险工具注入（P0-5 后大部分场景 plan 已经带上，这里做安全网）
    let toolsToUse = Array.isArray(plan?.tools_to_use) ? [...plan.tools_to_use] : [];
    const SEARCH_KEYWORDS = /搜索|检索|查一下|查一查|查询|最新|今天|今日|最近|近期|新闻|动态|政策|实时|目前|当前|股价|汇率|排行/;
    const messageWantsSearch = perception.scenario === '信息查询' || SEARCH_KEYWORDS.test(message);
    if (messageWantsSearch && !toolsToUse.includes('web_search')) {
      toolsToUse.unshift('web_search');
    }
    // 去重
    toolsToUse = [...new Set(toolsToUse)];

    // ── 3b. 并行：RAG + Tools
    const ragPromise = (async () => {
      if (!config.rag.enabled) return { hitCount: 0 };
      // 用 message 主导 + key_intents 补充；不再拼接整个 summary（避免污染）
      const query = [message, ...(perception.key_intents || [])].join(' ').trim();
      try {
        const chunks = retrieve(query, config.rag.topK, config.rag.minScore);
        if (chunks?.length) ragContext = formatForPrompt(chunks);
        log.info('rag.done', { hitCount: chunks?.length || 0, query: query.slice(0, 80) });
        return { hitCount: chunks?.length || 0 };
      } catch (err) {
        log.warn('rag.fail', { msg: err.message?.slice(0, 200) });
        return { hitCount: 0 };
      }
    })();

    // P1-2: 工具参数由 LLM function calling 提供（比 heuristic 精准）
    //   - 用 plan.tools_to_use 限定候选（LLM 无法凭空跑其他工具）
    //   - tool_choice='auto'，temp=0，max_tokens=300（只是抽参数，不生成正文）
    //   - 抽参失败 → 降级 heuristic（保证不中断）
    const toolCallsPromise = (async () => {
      if (!toolsToUse.length) return [];
      const allSchema = getToolsSchema();
      const selectedSchema = allSchema.filter(s => toolsToUse.includes(s.function.name));
      if (!selectedSchema.length) return [];

      try {
        const argsMsg = [
          { role: 'system', content:
              `你的唯一任务是根据用户消息，为下列工具生成合适的调用参数（可选择多个工具）。
用户消息：${message}
感知信息：${JSON.stringify({ scenario: perception.scenario, key_intents: perception.key_intents })}
规则：
- 只从下列工具中选择需要调用的
- 参数值必须严格符合 schema
- 如果用户没有说明具体课程/学科，可以不调用相关工具
- web_search 的 query 应精炼，去掉"请帮我查"等口语` },
          { role: 'user', content: message },
        ];
        const { toolCalls } = await chat({
          step: 'plan',
          messages: argsMsg,
          tools: selectedSchema,
          tool_choice: 'auto',
          temperature: 0,
          maxTokens: 400,
          traceId, log,
        });
        // 解析 tool_calls
        const parsed = (toolCalls || []).map(tc => {
          let args = {};
          try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
          return { name: tc.function?.name, args };
        }).filter(x => x.name && toolsToUse.includes(x.name));
        log.info('tool.args_extracted', { count: parsed.length, tools: parsed.map(x => x.name) });
        return parsed;
      } catch (err) {
        log.warn('tool.args_llm_fail_use_heuristic', { msg: err.message?.slice(0, 200) });
        // 降级：用 heuristic
        return toolsToUse.map(name => ({ name, args: extractToolArgs(name, message, perception) }));
      }
    })();

    const [ragResult, toolCallSpecs] = await Promise.all([ragPromise, toolCallsPromise]);

    // 执行工具
    const toolResArr = await Promise.all(
      toolCallSpecs.map(async ({ name, args }) => {
        try {
          const result = await executeTool(name, args);
          log.info('tool.ok', { toolName: name, args: shortJson(args), summary: summarizeTool(name, result) });
          return { toolName: name, success: true, result, args };
        } catch (err) {
          log.warn('tool.fail', { toolName: name, msg: err.message?.slice(0, 200) });
          return { toolName: name, success: false, error: err.message };
        }
      })
    );
    toolsUsed = toolResArr;

    if (ragResult.hitCount) emit('execute', 'running', `知识库命中 ${ragResult.hitCount} 条`);
    else if (config.rag.enabled) emit('execute', 'running', '知识库无匹配');

    if (toolsToUse.length) {
      const toolSummary = toolResArr.map(({ toolName, success, result, error }) => {
        if (!success) return `${toolName}❌`;
        if (toolName === 'web_search') {
          if (result?.error) return `${toolName}❌`;
          return `${toolName}✓${result?.engine || ''} ${result?.count || 0}条`;
        }
        return `${toolName}✓`;
      }).join(' | ');
      emit('execute', 'running', `工具：${toolSummary}`);

      // ── 3c. 工具结果结构化拼接（P1-3：用 formatToolResult 生成 markdown 友好格式）
      for (const { toolName, success, result, error } of toolResArr) {
        if (success) toolResults += `\n\n${formatToolResult(toolName, result)}`;
        else         toolResults += `\n\n[工具 ${toolName} 失败] ${error}`;
      }
    }

    // ── 3d. Skill 注入
    const skillCtx = { perception, plan, identity, message };
    const { systemAppend, triggeredSkills } = await applySkills(skillCtx);
    if (triggeredSkills.length) emit('execute', 'running', `已激活技能: ${triggeredSkills.join(', ')}`);

    // ── 3e. 构建 system prompt
    const systemPrompt = buildExecuteSystem({
      workflowSystemPrompt: workflow.systemPrompt + (systemAppend || ''),
      summary,
      perception,
      ragContext,
      toolResults,
      hasWebSearch: toolsToUse.includes('web_search'),
    });

    const executeMessages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-10),
      { role: 'user', content: message },
    ];

    // ── 3f. 流式调用（关键新增：P0-2）
    let firstDeltaAt = 0;
    let streamedContent = '';
    try {
      const streamRes = await chatStream({
        step: 'execute',
        messages: executeMessages,
        onDelta: (delta) => {
          if (!firstDeltaAt) firstDeltaAt = Date.now();
          streamedContent += delta;
          socket.emit('agent_delta', { delta, traceId });
        },
        traceId, log,
      });
      response = streamRes.content || streamedContent;
    } catch (err) {
      log.warn('execute.stream_fail_fallback_nonstream', { msg: err.message?.slice(0, 200) });
      // 流式失败 → 降级非流式
      const nonStream = await chat({ step: 'execute', messages: executeMessages, traceId, log });
      response = nonStream.content;
    }

    // ── 3g. 输出清洗（P0-4）
    response = cleanReply(response);

    const execDuration = Date.now() - executeStarted;
    log.info('execute.done', {
      duration: execDuration,
      firstDeltaMs: firstDeltaAt ? firstDeltaAt - executeStarted : null,
      outLen: response.length,
      tools: toolsUsed.map(t => `${t.toolName}${t.success ? '' : '!'}`).join(','),
    });
    emit('execute', 'done', `回复已生成 (${response.length}字, ${execDuration}ms)`);

    // ═════════ STEP 4 · REVIEW (P0-3 按需触发 + P1-4 grounding) ═════════
    const shouldReview = decideShouldReview({
      perception, response, workflow, toolsUsed, ragHit: ragResult.hitCount > 0,
    });

    if (shouldReview) {
      emit('review', 'running', '正在质检...');
      const reviewStarted = Date.now();
      review = await runReview({
        message, perception, response, ragContext, toolResults, traceId, log,
      });
      log.info('review.done', {
        duration: Date.now() - reviewStarted,
        score: review.score, grounding: review.grounding, issues: review.issues?.length || 0,
      });
      emit('review', 'done', `评分 ${review.score}/10${review.grounding === false ? ' · ⚠证据不足' : ''}`);
    } else {
      log.info('review.skipped', { reason: 'simple_case' });
      review = { score: 8, skipped: true, issues: [], suggestion: '' };
    }

    // ═════════ STEP 5 · CONCLUDE ═════════
    // 达标条件：分数达阈值 且 grounding 未标记为不足
    const needRefine =
      !review.skipped && (
        review.score < config.agent.reviewScoreThreshold ||
        review.grounding === false
      );

    if (needRefine) {
      emit('conclude', 'running', `评分不足，正在优化回复...`);
      const refineStarted = Date.now();
      response = await runRefine({
        message, perception, originalResponse: response, review,
        ragContext, toolResults, traceId, log,
      });
      response = cleanReply(response);
      refined = true;
      log.info('refine.done', { duration: Date.now() - refineStarted, outLen: response.length });
      emit('conclude', 'done', `已优化，最终 ${response.length} 字`);
    } else {
      emit('conclude', 'done', review.skipped ? '快速通道，直接输出' : '质量达标，输出最终回复');
    }

    // 摘要更新 —— P0-3 异步化：不阻塞返回，由 server.js 收到 result 后异步跑
    // 这里返回一个 lazy promise-builder，server.js 决定何时 await
    const totalDuration = Date.now() - perceiveStarted;
    log.info('agent.done', { totalDuration, refined, reviewed: shouldReview });

    return {
      success: true,
      response, perception, plan, review, refined,
      traceId,
      totalDuration,
      // 摘要更新器：调用方在合适时机 await
      updateSummary: async () => {
        try {
          const prompt = `请根据本轮对话，更新简短摘要（100 字内），保留：用户身份/年级/学科诉求/情绪状态/关键事实（如订单号、姓名）。
原摘要：${summary || '(无)'}
最新消息 U: ${message}
最新回复 A: ${response}
请输出更新后的摘要（100 字内）：`;
          const { content } = await chat({
            step: 'perceive',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            maxTokens: 200,
            traceId, log,
          });
          return content?.trim() || summary;
        } catch (err) {
          log.warn('summary.fail', { msg: err.message?.slice(0, 200) });
          return summary;
        }
      },
    };

  } catch (err) {
    log.error('agent.fatal', { err });
    const errorResponse = handleError(err, {
      step: 'agent_pipeline', message, identity, historyLength: history?.length || 0, traceId,
    });
    return {
      success: false,
      response: errorResponse.message,
      error: errorResponse.error,
      recoverySuggestion: errorResponse.recoverySuggestion,
      shouldRetry: errorResponse.shouldRetry,
      retryDelay: errorResponse.retryDelay,
      perception, traceId,
    };
  }
}

// ══════════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════════

/** heuristic plan（LLM 挂或跳过 plan 时兜底） */
function heuristicPlan(perception) {
  const tools = [];
  if (perception.scenario === '信息查询') tools.push('web_search');
  if (perception.scenario === '课程咨询') tools.push('get_course_info');
  const isEmotion = ['愤怒','焦虑','沮丧'].includes(perception.emotion) && perception.emotion_intensity >= 6;
  if (isEmotion) tools.push('get_comfort_template');
  return {
    tone: perception.emotion === '愤怒' ? '共情安慰' : '专业冷静',
    strategy: '按感知结果直接回答用户',
    tools_to_use: tools,
    key_points: perception.key_intents || [],
    length: perception.scenario === '闲聊' ? 'short' : 'medium',
  };
}

/** review 触发决策（P0-3 关键：只在必要时跑） */
function decideShouldReview({ perception, response, workflow, toolsUsed, ragHit }) {
  // 敏感场景一律 review
  if (perception.scenario === '投诉维权') return true;
  if (perception.urgency === '高') return true;
  if (perception.emotion_intensity >= 7) return true;
  // 有工具调用的（可能有幻觉/时效性问题）
  if (toolsUsed.length > 0) return true;
  // 回复较长且关键场景
  if (response.length >= 300 && perception.scenario !== '闲聊') return true;
  // 其他简单场景（闲聊 / 简短课程咨询）跳过
  return false;
}

/** 强化后的 review（P1-4） */
async function runReview({ message, perception, response, ragContext, toolResults, traceId, log }) {
  const prompt = `你是严格的回复质检专家（对教育机构 AI 客服）。请输出严格 JSON。

用户消息：${message}
感知结果：${JSON.stringify({ scenario: perception.scenario, emotion: perception.emotion, urgency: perception.urgency })}
AI 回复：${response}

【证据材料 — 用于 grounding 校验】
${ragContext || '(无 RAG 材料)'}
${toolResults || '(无工具结果)'}

评分维度（各项 1-10 分，严格）：
- relevance: 是否答到点上
- empathy: 语气是否匹配用户情绪
- accuracy: 事实是否与"证据材料"一致（回复里的具体数字/事实必须能在证据里找到；否则打 ≤ 5）
- tone: 语气是否合场景
- concise: 是否简明不啰嗦

额外必填：
- grounding (bool)：回复里所有具体数字/时间/人名/政策，是否都能在证据材料里找到；无法验证的即 false
- hallucination_risks (string[])：具体列出无据可查的断言（如"承诺 24 小时到账但证据里没有此政策"）

输出 JSON：
{
  "score": 综合(1-10 整数),
  "relevance": n, "empathy": n, "accuracy": n, "tone": n, "concise": n,
  "grounding": true|false,
  "hallucination_risks": ["...", "..."],
  "issues": ["主要问题（若有）"],
  "suggestion": "改进建议（若需要）"
}`;

  try {
    const { content } = await chat({
      step: 'review',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      maxTokens: 400,
      traceId, log,
    });
    const parsed = safeParseJSON(content, {
      score: 7, grounding: null, issues: [], suggestion: '', hallucination_risks: [],
    });
    // 硬约束：无证据材料就不能声称 grounding=true
    if (!ragContext && !toolResults) parsed.grounding = null; // 无法判断
    return parsed;
  } catch (err) {
    log.warn('review.llm_fail', { msg: err.message?.slice(0, 200) });
    return { score: 7, grounding: null, issues: [], suggestion: '', _fallback: true };
  }
}

/** refine：明确告诉 LLM 用证据 + 具体问题 */
async function runRefine({ message, perception, originalResponse, review, ragContext, toolResults, traceId, log }) {
  const prompt = `请根据以下问题清单和证据材料重写 AI 回复。只输出重写后的回复正文，不要任何解释、不要标签、不要"重写后:"前缀。

【用户原消息】${message}
【感知】${perception.scenario} · ${perception.emotion}(${perception.emotion_intensity}/10)

【原回复】
${originalResponse}

【发现的问题】${(review.issues || []).join('；') || '(无具体问题)'}
【幻觉风险】${(review.hallucination_risks || []).join('；') || '(无)'}
【改进建议】${review.suggestion || '语气更自然，事实更精准'}

${ragContext ? '【必须依据的知识材料】\n' + ragContext : ''}
${toolResults ? '【必须依据的工具结果】\n' + toolResults : ''}

要求：
1. 不能编造"证据材料"中没有的具体数字/政策/时间承诺
2. 保持原有语气基调，只修正问题
3. 如原回复过长，可精简；如太短漏点，可补充
4. 不要输出任何思考过程或旁白`;

  const { content } = await chat({
    step: 'refine',
    messages: [{ role: 'user', content: prompt }],
    traceId, log,
  });
  return content || originalResponse;
}

/** 构建 execute 步骤 system prompt（保留旧版所有加固） */
function buildExecuteSystem({ workflowSystemPrompt, summary, perception, ragContext, toolResults, hasWebSearch }) {
  const sections = [];

  // 顶部：工具数据（最高优先级）
  if (toolResults) {
    if (hasWebSearch) {
      sections.push(`【实时工具数据 — 最高优先级】
以下内容通过工具刚刚实时获取，必须作为你回答的事实来源：

${toolResults}

回答硬性要求：
1. 禁止说"我无法检索"/"我没法联网"/"知识截止于..."等任何回避表达
2. 必须基于上面的工具数据回答
3. web_search 结果用 title/snippet 简洁小结
4. 末尾"参考来源："列 2-3 条真实链接（来自 url 字段）
5. 不允许编造链接或来源`);
    } else {
      sections.push(`【工具数据】\n${toolResults}`);
    }
  }

  // 中部：workflow + skills（作为角色人设）
  sections.push(workflowSystemPrompt);

  // 记忆
  if (summary) {
    sections.push(`【长期记忆摘要】\n${summary}\n请保持对话连贯性，不要重复询问已知信息。`);
  }

  // 感知信息给 LLM 参考（避免自己重新判断情绪）
  sections.push(`【当前用户画像】
- 身份：${perception.identity}
- 情绪：${perception.emotion}（强度 ${perception.emotion_intensity}/10）
- 场景：${perception.scenario}
- 紧急度：${perception.urgency}
- 核心诉求：${(perception.key_intents || []).join('；') || '按上下文自行判断'}`);

  // 硬性约束（P0-4 的 cleanReply 会兜底，但仍给模型行为约束）
  sections.push(`【输出约束】
1. 直接输出回复正文，不要"(思考过程)"、"【动作描述】"、"（旁白）"等标记
2. 不要"AI:"、"Bot:"、"助手:" 前缀
3. 拒绝 AI 味：不说"作为 AI 助手"、"很高兴为您服务"
4. 简明扼要：能一句说清绝不两句；除非用户要求详细`);

  // 底部：RAG（作为补充参考）
  if (ragContext) sections.push(ragContext);

  return sections.filter(Boolean).join('\n\n');
}

// ── 启发式工具参数提取（P1-2 会换成 function calling 后弃用）
function extractToolArgs(toolName, message, perception) {
  const argMap = {
    get_course_info:    () => ({ courseName: extractCourseName(message) }),
    get_teacher_info:   () => ({ subject: extractSubject(message) }),
    get_schedule:       () => ({ courseName: extractSubject(message) }),
    calculate_discount: () => ({ originalPrice: '9800', discountType: 'nine_fold' }),
    check_order_status: () => ({ orderId: extractOrderId(message) }),
    get_faq:            () => ({ question: message }),
    get_comfort_template: () => ({
      emotion: { '愤怒':'angry','焦虑':'anxious','沮丧':'sad' }[perception?.emotion] || 'frustrated',
      scenario: perception?.scenario,
    }),
    plan_learning_path: () => ({
      subject: extractSubject(message),
      currentLevel: message.includes('基础差') || message.includes('薄弱') ? 'poor' : 'medium',
    }),
    web_search: () => ({ query: extractSearchQuery(message), num: 5 }),
  };
  return (argMap[toolName] || (() => ({})))();
}

function extractCourseName(msg) {
  const names = ['精英班', '提升班', '基础班', '单科强化班', '强化班', '单科'];
  return names.find(n => msg.includes(n)) || '';
}
function extractSubject(msg) {
  const subjects = ['数学', '语文', '英语', '物理', '化学', '生物', '历史', '地理'];
  return subjects.find(s => msg.includes(s)) || '';
}
function extractOrderId(msg) {
  const match = msg.match(/XG\d{9,}/);
  return match ? match[0] : '';
}
function extractSearchQuery(msg) {
  return String(msg || '')
    .replace(/^(请|帮我|麻烦|能否|可以|想|我想|我要|帮忙|请问)\s*/g, '')
    .replace(/[？?。！!，,；;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function summarizeTool(toolName, result) {
  if (!result || result.error) return `err:${result?.error || 'unknown'}`;
  if (toolName === 'web_search') return `engine=${result.engine || '?'} count=${result.count || 0}`;
  if (typeof result === 'object' && result.found !== undefined) return `found=${result.found}`;
  return 'ok';
}
function shortJson(obj) {
  try { return JSON.stringify(obj).slice(0, 100); } catch { return '?'; }
}

module.exports = { runAgent };
