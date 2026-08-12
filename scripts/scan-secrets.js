#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ignoredDirs = new Set(['.git', 'node_modules', '.claude', 'uploads', 'profiles']);
const ignoredFiles = new Set(['package-lock.json', 'scan-secrets.js']);
const allowedFiles = new Set(['.env.example']);
const findings = [];

const patterns = [
  { name: 'API key', regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'Tavily key', regex: /\btvly-[A-Za-z0-9_-]{12,}\b/g },
  { name: 'MongoDB URI with credentials', regex: /mongodb(?:\+srv)?:\/\/[^\s"'<>:@]+:[^\s"'<>@]+@[^\s"'<>]+/gi },
  { name: 'Private key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (ignoredFiles.has(entry.name) || allowedFiles.has(entry.name)) continue;
    const stat = fs.statSync(full);
    if (stat.size > 2 * 1024 * 1024) continue;
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(text))) {
        const line = text.slice(0, match.index).split('\n').length;
        findings.push(`${path.relative(root, full)}:${line} ${pattern.name}`);
      }
    }
  }
}

walk(root);
if (findings.length) {
  console.error('检测到疑似密钥，拒绝继续：');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log('Secret scan passed.');
