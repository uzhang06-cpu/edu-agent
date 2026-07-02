/**
 * services/logger.js
 * ──────────────────────────────────────────────────────────────────
 *  轻量结构化日志器：无外部依赖，可直接切到 pino。
 *
 *  用法：
 *    const log = require('./logger').child({ traceId });
 *    log.info('llm.call', { step: 'perceive', tokens: 120 });
 *
 *  产出格式（stdout，每行一条 JSON）：
 *    {"ts":"2026-07-02T10:00:00.000Z","lvl":"info","evt":"llm.call","traceId":"abc","step":"perceive","tokens":120}
 * ──────────────────────────────────────────────────────────────────
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

/** 生成短 traceId（8 位十六进制 + 时间戳后缀） */
function newTraceId() {
  const rand = Math.random().toString(16).slice(2, 10);
  const ts   = Date.now().toString(36).slice(-4);
  return `${rand}-${ts}`;
}

function stringifySafe(obj) {
  try { return JSON.stringify(obj); }
  catch { return JSON.stringify({ _err: 'circular_or_bigint' }); }
}

function emit(level, evt, fields, base) {
  if (LEVELS[level] < CURRENT) return;
  const line = {
    ts:  new Date().toISOString(),
    lvl: level,
    evt,
    ...base,
    ...fields,
  };
  // 错误对象特殊处理
  if (fields && fields.err instanceof Error) {
    line.err = { msg: fields.err.message, code: fields.err.code, stack: fields.err.stack?.split('\n').slice(0, 4).join(' | ') };
  }
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(stringifySafe(line) + '\n');
}

function make(base = {}) {
  return {
    debug: (evt, fields) => emit('debug', evt, fields, base),
    info:  (evt, fields) => emit('info',  evt, fields, base),
    warn:  (evt, fields) => emit('warn',  evt, fields, base),
    error: (evt, fields) => emit('error', evt, fields, base),
    child: (extra) => make({ ...base, ...extra }),
  };
}

module.exports = { logger: make(), newTraceId };
