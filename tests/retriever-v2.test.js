/**
 * tests/retriever-v2.test.js
 *   验证 BM25 检索质量 + 分词 + 同义词扩展
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize, expandTokens, retrieve, forceRebuild, getStats } = require('../knowledge/retriever-v2');

// 确保初始化完成
forceRebuild();

test('tokenize 生成 bigram/trigram', () => {
  const t = tokenize('精英班');
  assert.ok(t.includes('精英'), '应有 bigram 精英');
  assert.ok(t.includes('英班'), '应有 bigram 英班');
  assert.ok(t.includes('精英班'), '应有 trigram 精英班');
});

test('tokenize 过滤停用词', () => {
  const t = tokenize('请问价格');
  assert.ok(!t.includes('请问'), '停用词应过滤');
  assert.ok(t.includes('价格'), '关键词保留');
});

test('tokenize 处理拉丁词', () => {
  const t = tokenize('英语 English 课程');
  assert.ok(t.includes('english'), '英文小写保留');
});

test('expandTokens 同义词展开', () => {
  const e = expandTokens(['学费']);
  assert.ok(e.includes('价格'), '"学费" 应展开出标准词 "价格"');
});

test('BM25 检索：语义查询命中正确课程', () => {
  const stats = getStats();
  assert.ok(stats.N >= 3, `文档数不足：${stats.N}`);

  const r1 = retrieve('精英班多少钱？', 3, 0.5);
  assert.ok(r1.length >= 1, '至少命中一条');
  assert.equal(r1[0].id, 'c1', `应最相关命中"精英班" (c1)，实际 ${r1[0].id}`);
});

test('BM25 检索：同义词命中', () => {
  // "学费" → 展开为 "价格"，测试 kb 里的"¥19800/年"等描述
  const r = retrieve('学费多少', 3, 0.5);
  assert.ok(r.length >= 1, '同义词展开后应有命中');
});

test('BM25 检索：无关查询空返回', () => {
  const r = retrieve('宇宙飞船轨道', 3, 0.5);
  assert.equal(r.length, 0, '完全无关词汇不应命中');
});
