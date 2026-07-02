/**
 * tests/text-cleaner.test.js
 * ──────────────────────────────────────────────────────────────────
 *  单元测试 —— 用 node --test 直接跑：
 *    node --test tests/text-cleaner.test.js
 *
 *  验证 P0-4 的两条底线：
 *  1. 旁白型括号必须清除
 *  2. 语义括号必须保留（这是原实现的 bug）
 * ──────────────────────────────────────────────────────────────────
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanReply, isNarration } = require('../services/text-cleaner');

// ── 应保留的语义括号 ──────────────────────────────────────────────
const KEEP = [
  ['精英班（一对一）',                        '精英班（一对一）'],
  ['数学（高中）、物理（高中）',              '数学（高中）、物理（高中）'],
  ['学费 ¥9800（¥/年）',                     '学费 ¥9800（¥/年）'],
  ['每周 3 节 × 60 分钟',                     '每周 3 节 × 60 分钟'],
  ['基础班(录播)：适合基础薄弱的同学',        '基础班(录播)：适合基础薄弱的同学'],
  ['48 节（每年）',                          '48 节（每年）'],
  ['报名后（7 日）可全额退款',                '报名后（7 日）可全额退款'],
];

// ── 应删除的旁白型括号 ────────────────────────────────────────────
const REMOVE = [
  ['你好（微笑）',                            '你好'],
  ['我理解您的心情（点头）',                  '我理解您的心情'],
  ['（思考中）好的，我帮您查一下',             '好的，我帮您查一下'],
  ['（内心 OS：这个客户真挑剔）我给您推荐',    '我给您推荐'],
  ['同学你好（语气温柔）',                    '同学你好'],
  ['【思考过程】用户想问价格',                 '用户想问价格'],  // 方头括号 4+ 字必删
  ['我们的精英班（这是一个非常好的选择哦）',   '我们的精英班'],
  ['好的，我明白了。（笑着说道）',            '好的，我明白了。'],
  ['（旁白：AI 正在推荐课程）',                ''],
];

// ── AI 前缀去除 ──────────────────────────────────────────────────
const PREFIX = [
  ['AI：您好，我是小助',   '您好，我是小助'],
  ['Bot: 已收到',          '已收到'],
  ['助手：您可以试听',      '您可以试听'],
];

test('cleanReply 保留语义括号', () => {
  for (const [input, want] of KEEP) {
    const got = cleanReply(input);
    assert.equal(got, want, `期望保留：${JSON.stringify(input)} → ${JSON.stringify(want)}，实际得到 ${JSON.stringify(got)}`);
  }
});

test('cleanReply 删除旁白型括号', () => {
  for (const [input, want] of REMOVE) {
    const got = cleanReply(input);
    assert.equal(got, want, `期望清除旁白：${JSON.stringify(input)} → ${JSON.stringify(want)}，实际得到 ${JSON.stringify(got)}`);
  }
});

test('cleanReply 去 AI 前缀', () => {
  for (const [input, want] of PREFIX) {
    assert.equal(cleanReply(input), want);
  }
});

test('cleanReply 处理空输入', () => {
  assert.equal(cleanReply(''), '');
  assert.equal(cleanReply(null), '');
  assert.equal(cleanReply(undefined), '');
});

test('cleanReply 合并多重空行', () => {
  const input = '第一段\n\n\n\n\n第二段';
  assert.equal(cleanReply(input), '第一段\n\n第二段');
});

test('isNarration 判定', () => {
  assert.equal(isNarration('思考中'), true);
  assert.equal(isNarration('微笑'), true);
  assert.equal(isNarration('注：这个价格已含优惠'), true);   // 冒号 → 旁白
  assert.equal(isNarration('一对一'), false);
  assert.equal(isNarration('高中'), false);
  assert.equal(isNarration('¥/年'), false);
  assert.equal(isNarration('7 日'), false);
});
