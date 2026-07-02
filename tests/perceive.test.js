/**
 * tests/perceive.test.js
 *   聚焦"heuristic 兜底"，无网络依赖也能保证质量下限
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { heuristicPerceive, scoreKeywords, KEYWORDS } = require('../agent/perceive');

test('投诉关键词强命中 → 投诉维权 + 高紧急', () => {
  const r = heuristicPerceive('我要投诉！报名一个月没排课，要退款！');
  assert.equal(r.scenario, '投诉维权');
  assert.equal(r.urgency, '高');
  assert.ok(r.emotion_intensity >= 7);
});

test('时效关键词 → 信息查询', () => {
  const r = heuristicPerceive('帮我查一下今天美元汇率');
  assert.equal(r.scenario, '信息查询');
});

test('课程/价格关键词 → 课程咨询', () => {
  const r = heuristicPerceive('精英班多少钱？跟提升班比哪个好？');
  assert.equal(r.scenario, '课程咨询');
});

test('题目关键词 → 专业问题', () => {
  const r = heuristicPerceive('这道题 x²-5x+6=0 怎么解？');
  assert.equal(r.scenario, '专业问题');
});

test('无关键词短句 → 闲聊', () => {
  const r = heuristicPerceive('哈哈');
  assert.equal(r.scenario, '闲聊');
});

test('多个感叹号 → 情绪强度加成', () => {
  const r = heuristicPerceive('我很生气！！！怎么这么慢！！！');
  assert.ok(r.emotion_intensity >= 7);
});

test('识别家长身份关键词', () => {
  const r = heuristicPerceive('我家孩子高一物理很差');
  assert.equal(r.identity, '家长');
});

test('scoreKeywords 投诉高优先级检测', () => {
  const s = scoreKeywords('投诉！退款！骗人！', KEYWORDS);
  assert.ok((s['投诉维权'] || 0) >= 2);
});
