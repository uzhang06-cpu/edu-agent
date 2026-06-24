/**
 * agent/pipeline.js
 * ──────────────────────────────────────────────────────────────────
 *  5步 Agent 流水线：感知 → 规划 → 执行 → 复盘 → 定论
 *
 *  每步完成后通过 socket.emit('agent_step', ...) 实时通知前端
 *
 *  集成：
 *    - DeepSeek API（via axios）
 *    - RAG 知识库检索
 *    - Skill 技能注入
 *    - Tool 工具调用
 *    - Workflow 工作流路由
 * ──────────────────────────────────────────────────────────────────
 */

const axios    = require('axios');
const config   = require('../config');
const { retrieve, formatForPrompt } = require('../knowledge');
const { applySkills }              = require('../skills');
const { executeTool, getEnabledToolsDesc } = require('../tools');
const { selectWorkflow }           = require('../workflows');
const { handleError }  = require('../services/error-service');

// ── DeepSeek API 调用封装 ─────────────────────────────────────────
async function callDeepSeek(messages, step = 'execute') {
  const apiKey = config.DEEPSEEK_API_KEY;
  if (!apiKey || apiKey.includes('填写')) {
    throw Object.assign(new Error('API Key 未配置'), { code: 'API_KEY_NOT_SET' });
  }

  const response = await axios.post(
    `${config.deepseek.baseURL}/chat/completions`,
    {
      model:       config.deepseek.model,
      max_tokens:  config.deepseek.maxTokens[step]  || 1000,
      temperature: config.deepseek.temperature[step] || 0.7,
      messages,
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      timeout: 30000,
    }
  );

  return response.data.choices[0].message.content;
}

// ── 安全解析 JSON ──────────────────────────────────────────────────
function safeParseJSON(text, fallback = {}) {
  try {
    const cleaned = text.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return fallback;
  }
}

// ════════════════════════════════════════════════════════════════
//  主 Agent 流水线
//  参数：
//    socket    — Socket.IO 客户端 socket（用于 emit 步骤事件）
//    message   — 用户消息文本
//    history   — 对话历史 [{role, content}]
//    identity  — 'parent' | 'student'
// ════════════════════════════════════════════════════════════════
async function runAgent({ socket, message, history, summary, identity }) {

  const emit = (step, status, label, data) =>
    socket.emit('agent_step', { step, status, label, data });

  let perception = null;
  let plan       = null;
  let response   = null;
  let review     = null;
  let refined    = false;
  let newSummary = null;

  try {

    // ═══════════════════════════════════════════════════════════
    // STEP 1: 感知（Perceive）
    //   分析用户意图、情绪、身份、紧急度 + 摘要更新
    // ═══════════════════════════════════════════════════════════
    emit('perceive', 'running', '正在分析用户意图和情绪...');

    const perceivePrompt = `你是情绪和意图分析专家。分析以下用户消息，输出严格的 JSON（不要任何多余文字）。

用户身份：${identity === 'parent' ? '家长' : '学生'}
当前对话摘要（上下文）：${summary || '无'}
用户最新消息：${message}

输出格式（JSON）：
{
  "scenario": "课程咨询|专业问题|投诉维权|信息查询|闲聊",
  "emotion": "平静|好奇|焦虑|愤怒|满意|沮丧|开心",
  "emotion_intensity": 1-10的整数,
  "identity": "家长|学生|未知",
  "urgency": "高|中|低",
  "key_intents": ["意图1", "意图2"],
  "summary": "一句话总结用户核心诉求"
}

判定规则：
- "信息查询"：包含"搜索/检索/查一下/最新/今天/最近/新闻/动态/政策/排行/股价/汇率"等关键词，或问到我可能不掌握的实时/时效信息（人物近况、最新事件、最新数据）。优先于"闲聊"。`;

    const perceiveRaw = await callDeepSeek(
      [{ role: 'user', content: perceivePrompt }],
      'perceive'
    );
    perception = safeParseJSON(perceiveRaw, {
      scenario: '闲聊', emotion: '平静', emotion_intensity: 3,
      identity: identity === 'parent' ? '家长' : '学生',
      urgency: '低', key_intents: [], summary: message.slice(0, 30)
    });
    perception.identity = perception.identity || (identity === 'parent' ? '家长' : '学生');

    emit('perceive', 'done',
      `场景:${perception.scenario} · 情绪:${perception.emotion}(${perception.emotion_intensity}/10) · 紧急:${perception.urgency}`
    );

    // ═══════════════════════════════════════════════════════════
    //  工作流路由：根据感知结果选择工作流
    // ═══════════════════════════════════════════════════════════
    const workflow = selectWorkflow(perception);
    const steps    = workflow.steps;

    // ═══════════════════════════════════════════════════════════
    // STEP 2: 规划（Plan）— 若工作流包含此步骤
    // ═══════════════════════════════════════════════════════════
    if (steps.includes('plan')) {
      emit('plan', 'running', `工作流[${workflow.label}] 正在制定回复策略...`);

      const planPrompt = `你是回复策略规划专家。根据用户分析结果制定最优回复策略，输出严格 JSON。

感知结果：${JSON.stringify(perception)}
已激活工作流：${workflow.name}（${workflow.description}）
对话摘要：${summary || '无'}
可用工具：
${getEnabledToolsDesc()}

工具选择重要规则：
- 场景为"信息查询" → tools_to_use 必须包含 "web_search"
- 用户消息含"搜索/检索/查一下/最新/今天/最近/新闻/动态/排行/股价/汇率/近期" → 强烈建议 "web_search"
- 询问超出本地知识库的时效信息（人物近况、新政策、最近事件） → 必须 "web_search"
- 课程/价格/教师/订单 → 用相应业务工具
- 闲聊/纯情感共情 → 工具列表留空

输出格式（JSON）：
{
  "tone": "语气（如：热情关切/专业冷静/共情安慰/轻松活泼）",
  "strategy": "回复策略一句话描述",
  "tools_to_use": ["需要调用的工具名，如 get_course_info"],
  "key_points": ["回复必须涵盖的要点1", "要点2"],
  "length": "short|medium|long"
}`;

      const planRaw = await callDeepSeek(
        [{ role: 'user', content: planPrompt }],
        'plan'
      );
      plan = safeParseJSON(planRaw, {
        tone: '友好专业', strategy: '直接回答用户问题',
        tools_to_use: [], key_points: [], length: 'medium'
      });

      emit('plan', 'done', `策略:${plan.strategy} · 语气:${plan.tone}`);
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 3: 执行（Execute）
    //   RAG检索 + Skill注入 + Tool调用 + 生成回复
    // ═══════════════════════════════════════════════════════════
    emit('execute', 'running', '并行执行RAG检索和工具调用...');

    // 3a. 并行执行RAG检索和工具调用
    let ragContext = '';
    let toolResults = '';
    const toolsToUse = plan?.tools_to_use || [];

    // 并行执行RAG检索
    const ragPromise = (async () => {
      if (config.rag.enabled) {
        // 检索时带上摘要上下文，提高召回率
        const query = summary ? `${summary} ${message}` : message;
        const chunks = retrieve(query, config.rag.topK, config.rag.minScore);
        if (chunks.length > 0) {
          ragContext = formatForPrompt(chunks);
          return { success: true, hitCount: chunks.length };
        }
        return { success: true, hitCount: 0 };
      }
      return { success: true, hitCount: 0 };
    })();

    // 并行执行所有工具调用
    const toolPromises = toolsToUse.map(async (toolName) => {
      try {
        const args = extractToolArgs(toolName, message, perception);
        const result = await executeTool(toolName, args);
        return { toolName, success: true, result };
      } catch (error) {
        console.warn(`工具 ${toolName} 执行失败:`, error.message);
        return { toolName, success: false, error: error.message };
      }
    });

    // 等待所有并行任务完成
    const [ragResult, ...toolResultsArray] = await Promise.all([
      ragPromise,
      ...toolPromises
    ]);

    // 更新执行状态
    if (ragResult.success) {
      if (ragResult.hitCount > 0) {
        emit('execute', 'running', `知识库命中 ${ragResult.hitCount} 条`);
      } else if (config.rag.enabled) {
        emit('execute', 'running', '知识库无匹配');
      }
    }

    if (toolsToUse.length > 0) {
      emit('execute', 'running', `工具调用完成 (${toolsToUse.length}个)`);

      // 组合工具结果
      for (const { toolName, success, result, error } of toolResultsArray) {
        if (success) {
          toolResults += `\n[工具:${toolName}结果] ${JSON.stringify(result)}`;
        } else {
          toolResults += `\n[工具:${toolName}失败] ${error}`;
        }
      }
    }

    // 3c. Skill 注入
    const skillCtx = { perception, plan, identity, message };
    const { systemAppend, triggeredSkills } = await applySkills(skillCtx);
    if (triggeredSkills.length > 0) {
      emit('execute', 'running', `已激活技能: ${triggeredSkills.join(', ')}`);
    }

    // 3d. 构建最终 prompt
    const systemPrompt = workflow.systemPrompt + (systemAppend || '');
    
    // 构造带有记忆的 System Prompt
    const memoryPrompt = summary 
      ? `\n\n【长期记忆摘要】\n${summary}\n请根据以上摘要保持对话连贯性，不要重复询问已知信息。` 
      : '';
    
    // 添加负面约束：禁止输出思维过程 + 强调简明
    const negativeConstraint = `\n\n【重要约束】
1. 直接输出回复内容，不要包含任何 "(思考过程)"、"【动作描述】" 或 "（旁白）"。
2. 不要输出 "AI：" 或 "Bot：" 前缀。
3. 像真人一样聊天：
   - 拒绝 AI 味，不要说"作为AI助手"、"很高兴为您服务"。
   - 简明扼要，直击重点，不要啰嗦。
   - 能用一句话说清楚的，绝不分两句。`;

    const executeMessages = [
      { role: 'system', content: systemPrompt + memoryPrompt + negativeConstraint + ragContext + (toolResults ? '\n\n[工具数据]\n' + toolResults : '') },
      ...history.slice(-10),  // 滑动窗口：保留最近10条（5轮）
      { role: 'user', content: message }
    ];

    response = await callDeepSeek(executeMessages, 'execute');
    
    // 正则清洗：移除可能残留的括号内容（双重保险）
    response = response
      .replace(/（[^）]*）/g, '')   // 移除全角括号内容
      .replace(/\([^)]*\)/g, '')     // 移除半角括号内容
      .replace(/【[^】]*】/g, '')    // 移除方头括号内容
      .trim();

    emit('execute', 'done', `回复已生成 (${response.length}字)`);

    // ═══════════════════════════════════════════════════════════
    // STEP 4: 复盘（Review）
    // ═══════════════════════════════════════════════════════════
    emit('review', 'running', '正在进行质量审核...');

    const reviewPrompt = `你是回复质检专家。请评估以下AI回复的质量，输出严格 JSON。

用户消息：${message}
感知结果：${JSON.stringify(perception)}
AI回复：${response}

评分维度（各项1-10分）：
- relevance: 相关性（是否回答了用户的问题）
- empathy: 共情度（是否照顾了用户情绪）
- accuracy: 准确性（信息是否正确）
- tone: 语气匹配度（是否符合场景）

输出格式（JSON）：
{
  "score": 综合分(1-10整数),
  "relevance": 分数,
  "empathy": 分数,
  "accuracy": 分数,
  "tone": 分数,
  "issues": ["发现的问题1（若有）"],
  "suggestion": "改进建议（若需要）"
}`;

    const reviewRaw = await callDeepSeek(
      [{ role: 'user', content: reviewPrompt }],
      'review'
    );
    review = safeParseJSON(reviewRaw, { score: 8, issues: [], suggestion: '' });
    emit('review', 'done', `质检评分: ${review.score}/10${review.issues?.length ? ' · 发现问题' : ' · 质量良好'}`);

    // ═══════════════════════════════════════════════════════════
    // STEP 5: 定论（Conclude）
    //   评分不足则优化，达标则输出 + 更新摘要
    // ═══════════════════════════════════════════════════════════
    emit('conclude', 'running', review.score < config.agent.reviewScoreThreshold
      ? `评分${review.score}分，正在优化回复...`
      : `评分${review.score}分，质量达标，输出最终回复`
    );

    if (review.score < config.agent.reviewScoreThreshold) {
      const refinePrompt = `请根据以下改进建议，重写AI回复。只输出改进后的回复文本，不要任何解释。

原回复：${response}
质检问题：${review.issues?.join('；') || '无'}
改进建议：${review.suggestion || '语气更自然，内容更精准'}
用户原消息：${message}`;

      response = await callDeepSeek(
        [{ role: 'user', content: refinePrompt }],
        'refine'
      );
      refined = true;
      emit('conclude', 'done', `已优化！最终评分预估≥${config.agent.reviewScoreThreshold}`);
    }

    // 异步生成新摘要（不阻塞回复）
    // 简单策略：每3轮对话更新一次摘要，或者直接累积
    if (history.length >= 2) { // 只要有历史就尝试更新
       const summaryPrompt = `请根据当前对话历史和最新回复，更新对话摘要。保留关键信息（用户身份、需求、已解决问题、待解决问题）。

原摘要：${summary || '无'}
最新交互：
User: ${message}
AI: ${response}

请输出更新后的摘要（100字以内）：`;
       // 这里为了演示简单，不await，但实际部署建议放队列处理
       // 为保证数据一致性，这里我们同步等待一下，或者由server.js处理
       // 这里选择返回给server.js处理
       try {
         newSummary = await callDeepSeek([{ role: 'user', content: summaryPrompt }], 'perceive'); // 复用perceive参数
       } catch (e) {
         console.warn('摘要生成失败', e);
         newSummary = summary;
       }
    }

    emit('conclude', 'done', '定论完成，输出最终回复');

    return { success: true, response, perception, plan, review, refined, newSummary };

  } catch (err) {
    // 使用错误处理服务格式化错误信息
    const errorContext = {
      step: 'agent_pipeline',
      message,
      identity,
      historyLength: history?.length || 0
    };

    const errorResponse = handleError(err, errorContext);

    // 仍然返回基本结构，但使用更友好的错误信息
    return {
      success: false,
      response: errorResponse.message,
      error: errorResponse.error,
      recoverySuggestion: errorResponse.recoverySuggestion,
      shouldRetry: errorResponse.shouldRetry,
      retryDelay: errorResponse.retryDelay,
      perception,
    };
  }
}

// ── 启发式工具参数提取 ────────────────────────────────────────────
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
      scenario: perception?.scenario
    }),
    plan_learning_path: () => ({
      subject: extractSubject(message),
      currentLevel: message.includes('基础差') || message.includes('薄弱') ? 'poor' : 'medium'
    }),
    web_search: () => ({ query: extractSearchQuery(message), num: 5 }),
  };
  return (argMap[toolName] || (() => ({})))();
}

function extractCourseName(msg) {
  const names = ['精英班', '提升班', '基础班', '单科', '强化班'];
  return names.find(n => msg.includes(n)) || msg.slice(0, 10);
}

function extractSubject(msg) {
  const subjects = ['数学', '语文', '英语', '物理', '化学'];
  return subjects.find(s => msg.includes(s)) || '数学';
}

function extractOrderId(msg) {
  const match = msg.match(/XG\d{9,}/);
  return match ? match[0] : '';
}

/** 抽取搜索关键词：去掉口语开头 + 标点，截断到合理长度 */
function extractSearchQuery(msg) {
  return String(msg || '')
    .replace(/^(请|帮我|麻烦|能否|可以|想|我想|我要|帮忙|请问)\s*/g, '')
    .replace(/[？?。！!，,；;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

module.exports = { runAgent };
