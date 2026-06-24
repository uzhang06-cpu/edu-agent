/**
 * services/web-search.js
 * ──────────────────────────────────────────────────────────────────
 *  Web 搜索：双通道
 *    1) 优先：Node→Python 调用 skills/multi-search/multi_search.py
 *       （多引擎兜底，原 skill: https://github.com/Nex-ZMH/Agent-websearch-skill）
 *    2) 回退：纯 Node 版 DuckDuckGo HTML 抓取（无 Python 依赖）
 *
 *  设计原则：在生产环境（可能没装 Python）一样能跑
 * ──────────────────────────────────────────────────────────────────
 */

const { spawn } = require('child_process');
const path      = require('path');
const axios     = require('axios');

const SKILL_DIR  = path.join(__dirname, '..', 'skills', 'multi-search');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
const PY_TIMEOUT = 15000;
const HTTP_TIMEOUT = 8000;

// ── 通道 1：Python skill ─────────────────────────────────────────
function tryPython(query, num) {
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
    let proc;
    try {
      proc = spawn(PYTHON_BIN, ['-c', code], { cwd: SKILL_DIR });
    } catch (e) {
      return resolve({ error: 'python_not_available' });
    }
    let out = '', err = '';
    const timer = setTimeout(() => { proc.kill(); resolve({ error: 'timeout' }); }, PY_TIMEOUT);
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', () => { clearTimeout(timer); resolve({ error: 'python_not_available' }); });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        // Python skill 可能先打印若干日志行，JSON 在某一行
        const lines = out.trim().split('\n').filter(Boolean);
        const jsonLine = [...lines].reverse().find(l => {
          const t = l.trim();
          return t.startsWith('{') || t.startsWith('[');
        });
        if (!jsonLine) return resolve({ error: 'no_json_in_stdout', stderr: err.slice(-200) });
        const parsed = JSON.parse(jsonLine);
        // 兼容两种返回：array 或 {results: [...]}
        if (Array.isArray(parsed)) return resolve({ engine_used: 'multi_search', results: parsed });
        if (parsed.error) return resolve({ error: parsed.error });
        resolve(parsed);
      } catch (e) {
        resolve({ error: 'parse_error: ' + e.message, stderr: err.slice(-200) });
      }
    });
  });
}

// ── 通道 2：纯 Node DuckDuckGo HTML 抓取 ─────────────────────────
async function tryDuckDuckGoHTML(query, num) {
  // DDG html 端点不需要 JS 执行，纯静态 HTML，正则可解
  const url = 'https://html.duckduckgo.com/html/';
  const { data: html } = await axios.post(
    url,
    new URLSearchParams({ q: query }).toString(),
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      timeout: HTTP_TIMEOUT,
      validateStatus: () => true,
    }
  );

  // 解析结果块（避免重型依赖；DDG HTML 结构相对稳定）
  // 每条结果：<a class="result__a" href="...">title</a> ... <a class="result__snippet">snippet</a>
  const results = [];
  const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = blockRe.exec(html)) && results.length < num) {
    const rawUrl = m[1];
    const title  = stripTags(m[2]).trim();
    const snippet = stripTags(m[4]).trim();
    // DDG 跳转链接形如 //duckduckgo.com/l/?uddg=ENCODED&...
    const realUrl = decodeDDGUrl(rawUrl);
    if (title && realUrl) results.push({ title, url: realUrl, snippet });
  }
  return { engine_used: 'duckduckgo_html', query, results };
}

function stripTags(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function decodeDDGUrl(href) {
  if (!href) return '';
  // 兼容 //duckduckgo.com/l/?uddg=...
  if (href.startsWith('//')) href = 'https:' + href;
  try {
    const u = new URL(href);
    const real = u.searchParams.get('uddg');
    return real ? decodeURIComponent(real) : href;
  } catch {
    return href;
  }
}

// ── 对外入口 ─────────────────────────────────────────────────────
async function webSearch({ query, num = 5 }) {
  if (!query || !String(query).trim()) return { error: '搜索词为空' };
  const q = String(query).trim();
  const n = Math.min(Math.max(Number(num) || 5, 1), 10);

  // 通道 1：Python skill
  const py = await tryPython(q, n);
  if (!py.error && (py.results?.length || py.answer)) {
    return normalize(py, q, n);
  }
  // 记录 fallback 原因，便于排查
  console.log(`[web_search] python channel unavailable (${py.error || 'empty'}), falling back to Node DDG`);

  // 通道 2：Node DDG
  try {
    const ddg = await tryDuckDuckGoHTML(q, n);
    if (ddg.results?.length) return normalize(ddg, q, n);
    return { error: '所有搜索通道均无结果', query: q };
  } catch (err) {
    return { error: `搜索失败: ${err.message}`, query: q };
  }
}

function normalize(raw, q, n) {
  const results = (raw.results || []).slice(0, n).map(r => ({
    title:   r.title || r.name || '',
    url:     r.url || r.link || r.href || '',
    snippet: r.snippet || r.content || r.body || r.description || ''
  })).filter(r => r.title || r.url);
  return {
    engine:  raw.engine_used || raw.engine || 'unknown',
    query:   raw.query || q,
    answer:  raw.answer || null,
    count:   results.length,
    results,
  };
}

module.exports = { webSearch };
