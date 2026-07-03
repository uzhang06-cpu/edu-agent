/**
 * tests/review-guard.test.js
 *   聚焦问题2的两个纯逻辑修复：
 *   - decideShouldReview：专业问题/闲聊无证据时不触发 review（避免"改坏")
 *   - isRefusal：识别"无法回答/无法检索"等拒答措辞（拒答守卫用）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideShouldReview, isRefusal } = require('../agent/pipeline');

const base = { emotion_intensity: 3, urgency: '低' };

test('专业问题（无工具/无RAG）不触发 review', () => {
  const should = decideShouldReview({
    perception: { ...base, scenario: '专业问题' },
    response: '1 不是质数。质数定义为大于 1 且只有 1 和自身两个因数的自然数……'.repeat(5),
    toolsUsed: [], ragHit: false,
  });
  assert.equal(should, false, '专业问题无证据不应 review');
});

test('闲聊不触发 review', () => {
  const should = decideShouldReview({
    perception: { ...base, scenario: '闲聊' },
    response: '哈哈你说得对', toolsUsed: [], ragHit: false,
  });
  assert.equal(should, false);
});

test('投诉维权一定触发 review', () => {
  const should = decideShouldReview({
    perception: { ...base, scenario: '投诉维权' },
    response: '非常抱歉', toolsUsed: [], ragHit: false,
  });
  assert.equal(should, true);
});

test('有工具调用触发 review', () => {
  const should = decideShouldReview({
    perception: { ...base, scenario: '信息查询' },
    response: '查询结果如下', toolsUsed: [{ toolName: 'web_search' }], ragHit: false,
  });
  assert.equal(should, true);
});

test('命中知识库的长回复触发 review', () => {
  const should = decideShouldReview({
    perception: { ...base, scenario: '课程咨询' },
    response: '精英班的详细介绍……'.repeat(20), toolsUsed: [], ragHit: true,
  });
  assert.equal(should, true);
});

test('isRefusal 识别拒答措辞', () => {
  assert.equal(isRefusal('抱歉，我无法检索到这个信息'), true);
  assert.equal(isRefusal('我没法联网查询'), true);
  assert.equal(isRefusal('这个问题超出我的能力范围，无法回答'), true);
  assert.equal(isRefusal('1 不是质数，因为它只有一个因数'), false);
  assert.equal(isRefusal('精英班 ¥19800/年，适合冲刺名校'), false);
});
