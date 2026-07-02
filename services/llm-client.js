/**
 * services/llm-client.js
 * ──────────────────────────────────────────────────────────────────
 *  DeepSeek LLM 统一客户端 — 所有对 LLM 的调用都必须走这里。
 *
 *  能力：
 *    - chat({ step, messages, ... })      → 非流式
 *    - chatStream({ step, messages, onDelta, ... }) → 流式（SSE）
 *    - 指数退避重试（429/5xx/超时/网络错，最多 3 次）
 *    - 简单熔断：连续失败 ≥3 → 熔断 30s → 半开 → 探测
 *    - Token 估算（中文 1/字，英文 1/4 字），入参超过 28K 直接截断 history 并告警
 *    - 每次调用打结构化日志：step / tokens / duration / attempt / status / traceId
 *    - 错误映射到 error-service 的 ErrorTypes（供上层复用）
 *
 *  外部依赖：仅 axios。
 * ──────────────────────────────────────────────────────────────────
 */

const axios  = require('axios');
const config = require('../config');
const { logger } = require('./logger');
const { ErrorTypes } = require('./error-service');

// ──────────────────────────────────────────────────────────────────
//  Token 估算（无 tokenizer 依赖；用于预算控制，不追求精确）
//  规则：ASCII 4 字符 ≈ 1 token；非 ASCII（中/日/韩）1 字 ≈ 1 token
// ──────────────────────────────────────────────────────────────────
function estimateTokens(text) {
  if (!text) return 0;
  let ascii = 0, wide = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else wide++;
  }
  return Math.ceil(ascii / 4) + wide;
}

function estimateMessagesTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0); // +4 role开销
}

// DeepSeek chat 模型上下文 64K（32K 输入更稳）；预留 output 4K
const MAX_INPUT_TOKENS = 28000;

/**
 * 保守裁剪 messages：保留首条 system + 最新 user + 尽可能多的近期 history
 * 用于 execute 步骤，输入 messages 是 [system, ...history, user]
 */
function trimMessagesToBudget(messages, budget = MAX_INPUT_TOKENS) {
  if (!messages.length) return messages;
  const total = estimateMessagesTokens(messages);
  if (total <= budget) return messages;

  // 保留 system + 最新 user
  const system = messages[0]?.role === 'system' ? messages[0] : null;
  const last   = messages[messages.length - 1];
  const middle = messages.slice(system ? 1 : 0, -1);

  // 从中间从后往前塞，直到超预算
  const kept = [];
  let used = estimateTokens((system?.content || '')) + estimateTokens(last.content) + 20;
  for (let i = middle.length - 1; i >= 0; i--) {
    const t = estimateTokens(middle[i].content) + 4;
    if (used + t > budget) break;
    kept.unshift(middle[i]);
    used += t;
  }

  const trimmed = [system, ...kept, last].filter(Boolean);
  logger.warn('llm.trim', {
    origMsgs: messages.length, keptMsgs: trimmed.length,
    origTokens: total, budgetTokens: budget, keptTokens: used,
  });
  return trimmed;
}

// ──────────────────────────────────────────────────────────────────
//  熔断器（简单版本，进程级单例）
// ──────────────────────────────────────────────────────────────────
const breaker = {
  state:            'closed',   // closed | open | half-open
  failStreak:       0,
  openedAt:         0,
  openTimeoutMs:    30_000,
  halfOpenProbe:    false,
  failThreshold:    3,          // 连续失败 N 次开启

  canPass() {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.openedAt > this.openTimeoutMs) {
        this.state = 'half-open';
        this.halfOpenProbe = false;
        logger.info('breaker.half_open', {});
      } else {
        return false;
      }
    }
    // half-open: 只放一个探测请求
    if (this.state === 'half-open') {
      if (this.halfOpenProbe) return false;
      this.halfOpenProbe = true;
      return true;
    }
    return true;
  },

  onSuccess() {
    if (this.state !== 'closed') {
      logger.info('breaker.close', { fromState: this.state });
    }
    this.state = 'closed';
    this.failStreak = 0;
    this.halfOpenProbe = false;
  },

  onFailure() {
    this.failStreak++;
    if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAt = Date.now();
      this.halfOpenProbe = false;
      logger.warn('breaker.reopen', { failStreak: this.failStreak });
      return;
    }
    if (this.state === 'closed' && this.failStreak >= this.failThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
      logger.error('breaker.open', { failStreak: this.failStreak, timeoutMs: this.openTimeoutMs });
    }
  },
};

// ──────────────────────────────────────────────────────────────────
//  错误分类：把 axios error 归类到 ErrorTypes
// ──────────────────────────────────────────────────────────────────
function classifyError(err) {
  if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) return ErrorTypes.API_TIMEOUT;
  if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED')     return ErrorTypes.API_NETWORK_ERROR;
  const status = err.response?.status;
  if (status === 401 || status === 403) return ErrorTypes.API_KEY_NOT_SET;
  if (status === 429) return ErrorTypes.API_RATE_LIMIT;
  const body = err.response?.data;
  if (body && typeof body === 'object' && /quota|balance|insufficient/i.test(JSON.stringify(body))) {
    return ErrorTypes.API_QUOTA_EXCEEDED;
  }
  if (status >= 500) return ErrorTypes.API_NETWORK_ERROR;
  return ErrorTypes.INTERNAL_ERROR;
}

/** 是否值得重试 */
function isRetryable(errType, status) {
  if (errType === ErrorTypes.API_TIMEOUT)       return true;
  if (errType === ErrorTypes.API_NETWORK_ERROR) return true;
  if (errType === ErrorTypes.API_RATE_LIMIT)    return true;
  if (status && status >= 500 && status < 600)  return true;
  return false;
}

// ──────────────────────────────────────────────────────────────────
//  核心：非流式 chat
// ──────────────────────────────────────────────────────────────────
async function chat({ step = 'execute', messages, temperature, maxTokens, tools, tool_choice, traceId, log = logger }) {
  const apiKey = config.DEEPSEEK_API_KEY;
  if (!apiKey || apiKey.includes('填写')) {
    const e = new Error('API Key 未配置'); e.code = 'API_KEY_NOT_SET'; e.errType = ErrorTypes.API_KEY_NOT_SET;
    throw e;
  }
  if (!breaker.canPass()) {
    const e = new Error('LLM 服务暂时不可用（熔断中）'); e.errType = ErrorTypes.API_NETWORK_ERROR;
    log.warn('llm.circuit_open', { step, traceId });
    throw e;
  }

  const trimmed = trimMessagesToBudget(messages);
  const inTokens = estimateMessagesTokens(trimmed);
  const body = {
    model:       config.deepseek.model,
    messages:    trimmed,
    temperature: temperature ?? (config.deepseek.temperature[step] ?? 0.7),
    max_tokens:  maxTokens   ?? (config.deepseek.maxTokens[step]   ?? 1000),
  };
  if (tools?.length)     body.tools       = tools;
  if (tool_choice)       body.tool_choice = tool_choice;

  const url = `${config.deepseek.baseURL}/chat/completions`;
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    try {
      const res = await axios.post(url, body, { headers, timeout: 25_000 });
      const duration = Date.now() - started;
      const msg  = res.data.choices?.[0]?.message || {};
      const usage = res.data.usage || {};

      breaker.onSuccess();
      log.info('llm.ok', {
        step, traceId, attempt, duration,
        inTokensEst: inTokens,
        inTokens:    usage.prompt_tokens,
        outTokens:   usage.completion_tokens,
        finish:      res.data.choices?.[0]?.finish_reason,
      });
      return {
        content:   msg.content || '',
        toolCalls: msg.tool_calls || [],
        usage,
        raw:       res.data,
      };
    } catch (err) {
      const duration = Date.now() - started;
      const status = err.response?.status;
      const errType = classifyError(err);
      err.errType = errType;
      lastErr = err;

      const retryable = isRetryable(errType, status);
      log.warn('llm.fail', {
        step, traceId, attempt, duration, status, errType,
        msg: err.message?.slice(0, 200),
        respBody: typeof err.response?.data === 'string'
          ? err.response.data.slice(0, 200)
          : err.response?.data,
        willRetry: retryable && attempt < MAX_ATTEMPTS,
      });

      if (!retryable || attempt === MAX_ATTEMPTS) {
        breaker.onFailure();
        throw err;
      }
      // 指数退避 + 抖动：0.8s, 2s, 4.5s
      const backoff = 800 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

// ──────────────────────────────────────────────────────────────────
//  核心：流式 chat（DeepSeek 的 SSE 兼容 OpenAI 格式）
//  onDelta(chunk) —— 每次收到增量 content 时调用
//  返回：{ content, toolCalls, usage } —— 完整拼接后的结果
// ──────────────────────────────────────────────────────────────────
async function chatStream({ step = 'execute', messages, temperature, maxTokens, tools, tool_choice, onDelta, traceId, log = logger }) {
  const apiKey = config.DEEPSEEK_API_KEY;
  if (!apiKey || apiKey.includes('填写')) {
    const e = new Error('API Key 未配置'); e.errType = ErrorTypes.API_KEY_NOT_SET;
    throw e;
  }
  if (!breaker.canPass()) {
    const e = new Error('LLM 服务暂时不可用（熔断中）'); e.errType = ErrorTypes.API_NETWORK_ERROR;
    throw e;
  }

  const trimmed = trimMessagesToBudget(messages);
  const inTokens = estimateMessagesTokens(trimmed);
  const body = {
    model:       config.deepseek.model,
    messages:    trimmed,
    temperature: temperature ?? (config.deepseek.temperature[step] ?? 0.7),
    max_tokens:  maxTokens   ?? (config.deepseek.maxTokens[step]   ?? 1000),
    stream:      true,
  };
  if (tools?.length) body.tools = tools;
  if (tool_choice)   body.tool_choice = tool_choice;

  const url = `${config.deepseek.baseURL}/chat/completions`;
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  // 流式不重试（用户看到部分文字后再从头就抖了）；但一开始就失败可重试 1 次
  const MAX_ATTEMPTS = 2;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    let firstByteAt = 0;
    try {
      const res = await axios.post(url, body, {
        headers, timeout: 25_000, responseType: 'stream',
      });

      let content   = '';
      const toolCallBuf = {};   // idx → {id, name, argsStr}
      let usage;

      await new Promise((resolve, reject) => {
        let buf = '';
        res.data.on('data', (chunk) => {
          if (!firstByteAt) firstByteAt = Date.now();
          buf += chunk.toString('utf8');
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line || !line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const j = JSON.parse(data);
              const d = j.choices?.[0]?.delta || {};
              if (d.content) {
                content += d.content;
                onDelta?.(d.content);
              }
              if (d.tool_calls) {
                for (const tc of d.tool_calls) {
                  const i = tc.index ?? 0;
                  const slot = toolCallBuf[i] || (toolCallBuf[i] = { id: '', name: '', argsStr: '' });
                  if (tc.id)                    slot.id      = tc.id;
                  if (tc.function?.name)        slot.name    = tc.function.name;
                  if (tc.function?.arguments)   slot.argsStr += tc.function.arguments;
                }
              }
              if (j.usage) usage = j.usage;
            } catch { /* ignore partial line */ }
          }
        });
        res.data.on('end',   resolve);
        res.data.on('error', reject);
      });

      const duration = Date.now() - started;
      const toolCalls = Object.values(toolCallBuf).map(s => ({
        id: s.id, type: 'function',
        function: { name: s.name, arguments: s.argsStr },
      }));

      breaker.onSuccess();
      log.info('llm.stream_ok', {
        step, traceId, attempt, duration,
        ttfb:        firstByteAt ? firstByteAt - started : null,
        inTokensEst: inTokens,
        outChars:    content.length,
        toolCalls:   toolCalls.length,
        usage,
      });
      return { content, toolCalls, usage };
    } catch (err) {
      const duration = Date.now() - started;
      const errType = classifyError(err);
      err.errType = errType;
      lastErr = err;

      const retryable = isRetryable(errType, err.response?.status) && !firstByteAt;
      log.warn('llm.stream_fail', {
        step, traceId, attempt, duration,
        errType, msg: err.message?.slice(0, 200),
        afterFirstByte: !!firstByteAt,
        willRetry: retryable && attempt < MAX_ATTEMPTS,
      });

      if (!retryable || attempt === MAX_ATTEMPTS) {
        breaker.onFailure();
        throw err;
      }
      await new Promise(r => setTimeout(r, 500 + Math.floor(Math.random() * 500)));
    }
  }
  throw lastErr;
}

// ──────────────────────────────────────────────────────────────────
//  辅助：安全 JSON 解析（LLM JSON 输出常见问题）
// ──────────────────────────────────────────────────────────────────
function safeParseJSON(text, fallback = {}) {
  if (!text) return fallback;
  try {
    // 剥掉 ```json ... ``` 包装 + 首尾非 JSON 字符
    let s = String(text).replace(/```json|```/gi, '').trim();
    // 找第一个 { 到最后一个 }
    const first = s.indexOf('{');
    const last  = s.lastIndexOf('}');
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

module.exports = {
  chat,
  chatStream,
  safeParseJSON,
  estimateTokens,
  estimateMessagesTokens,
  trimMessagesToBudget,
  breaker,
  MAX_INPUT_TOKENS,
};
