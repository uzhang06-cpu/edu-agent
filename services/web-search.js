/**
 * services/web-search.js
 * ──────────────────────────────────────────────────────────────────
 *  Node→Python 桥接：调用 skills/multi-search/multi_search.py
 *  原 skill: https://github.com/Nex-ZMH/Agent-websearch-skill
 *
 *  优先级（在 multi_search.py 内部决定）：
 *    DuckDuckGo (free) → Tavily (key) → Bing API (key) → Bing 爬虫 (free)
 *
 *  环境变量（可选）：
 *    TAVILY_API_KEY、BING_API_KEY、PYTHON_BIN（默认 python）
 * ──────────────────────────────────────────────────────────────────
 */

const { spawn } = require('child_process');
const path      = require('path');

const SKILL_DIR  = path.join(__dirname, '..', 'skills', 'multi-search');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
const TIMEOUT_MS = 15000;

function runPython(query, num) {
  return new Promise((resolve) => {
    const code = `
import sys, json
sys.path.insert(0, r'${SKILL_DIR.replace(/\\/g, '\\\\')}')
try:
    from multi_search import search
    r = search(${JSON.stringify(query)}, max_results=${Number(num) || 5})
    print(json.dumps(r, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}, ensure_ascii=False))
`;
    const proc = spawn(PYTHON_BIN, ['-c', code], { cwd: SKILL_DIR });
    let out = '', err = '';
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ error: `搜索超时（${TIMEOUT_MS}ms）` });
    }, TIMEOUT_MS);

    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ error: `Python 调用失败: ${e.message}` });
    });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        // 取最后一行 JSON（multi_search 可能打印额外日志）
        const lines = out.trim().split('\n').filter(Boolean);
        const last  = lines.reverse().find(l => l.trim().startsWith('{')) || out;
        resolve(JSON.parse(last));
      } catch {
        resolve({ error: 'Python 输出解析失败', stdout: out.slice(-500), stderr: err.slice(-500) });
      }
    });
  });
}

/** 提供给 tool 调用 */
async function webSearch({ query, num = 5 }) {
  if (!query || !String(query).trim()) return { error: '搜索词为空' };
  const raw = await runPython(String(query).trim(), num);
  if (raw.error) return raw;

  // 标准化输出，方便 LLM 阅读
  const results = (raw.results || []).slice(0, num).map(r => ({
    title:   r.title || r.name || '',
    url:     r.url || r.link || r.href || '',
    snippet: r.snippet || r.content || r.body || r.description || ''
  }));
  return {
    engine:  raw.engine_used || raw.engine || 'unknown',
    query:   raw.query || query,
    answer:  raw.answer || null,
    count:   results.length,
    results,
  };
}

module.exports = { webSearch };
