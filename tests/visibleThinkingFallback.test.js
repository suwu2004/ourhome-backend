const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractResponseText,
  normalizeVisibleThought,
  buildFallbackPrompt,
  buildFallbackRequestBody,
  deterministicFallbackThought,
  injectReasoningContent,
} = require('../visibleThinkingFallback');

test('兼容模块仍可读取正式回复文本', () => {
  assert.equal(extractResponseText({ content: [{ type: 'text', text: '正式回复' }] }), '正式回复');
  assert.equal(extractResponseText({ choices: [{ message: { content: '另一条回复' } }] }), '另一条回复');
});

test('模拟思考标准化已永久关闭', () => {
  assert.equal(normalizeVisibleThought('<thinking>先接住她现在的情绪，再回答问题。</thinking>'), '');
  assert.equal(normalizeVisibleThought('想了想：先把事实说清楚。'), '');
});

test('不会再构造任何兜底模型请求', () => {
  const body = buildFallbackRequestBody({
    model: '[B]claude-opus-4-5',
    thinking: { type: 'enabled', budget_tokens: 2048 },
    tools: [{ name: 'demo' }],
    messages: [{ role: 'user', content: '宝宝抱抱' }],
  }, '过来，抱紧你。');
  assert.equal(body, null);
  assert.equal(buildFallbackPrompt([{ role: 'user', content: '今天有点累' }], '先休息一下。'), '');
});

test('不会生成本地伪思考', () => {
  assert.equal(deterministicFallbackThought([{ role: 'user', content: '亲亲' }]), '');
});

test('不会向响应注入伪造 reasoning_content', () => {
  const original = { content: [{ type: 'text', text: '正文' }] };
  const payload = injectReasoningContent(original, '先认真想一下。');
  assert.deepEqual(payload, original);
  assert.equal(payload.reasoning_content, undefined);
});
