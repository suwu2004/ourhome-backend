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

test('可从 Anthropic 与 OpenAI 兼容响应中提取正式文本', () => {
  assert.equal(extractResponseText({ content: [{ type: 'text', text: '正式回复' }] }), '正式回复');
  assert.equal(extractResponseText({ choices: [{ message: { content: '另一条回复' } }] }), '另一条回复');
});

test('模拟思考会去掉标签和标题但保留正文', () => {
  assert.equal(
    normalizeVisibleThought('<thinking>先接住她现在的情绪，再回答问题。</thinking>'),
    '先接住她现在的情绪，再回答问题。',
  );
  assert.equal(normalizeVisibleThought('想了想：先把事实说清楚。'), '先把事实说清楚。');
});

test('兜底请求只生成可见思考，不携带主请求的 tools 与 thinking', () => {
  const body = buildFallbackRequestBody({
    model: '[B]claude-opus-4-5',
    thinking: { type: 'enabled', budget_tokens: 2048 },
    tools: [{ name: 'demo' }],
    messages: [{ role: 'user', content: '宝宝抱抱' }],
  }, '过来，抱紧你。');

  assert.equal(body.model, '[B]claude-opus-4-5');
  assert.equal(body.thinking, undefined);
  assert.equal(body.tools, undefined);
  assert.match(body.system, /只负责生成一段自然、可展示的中文思考记录/);
  assert.match(body.messages[0].content, /宝宝抱抱/);
  assert.match(body.messages[0].content, /过来，抱紧你/);
});

test('思考生成提示不要求分阶段或步骤', () => {
  const prompt = buildFallbackPrompt([{ role: 'user', content: '今天有点累' }], '先休息一下。');
  assert.match(prompt, /不要分阶段/);
  assert.match(prompt, /不要列步骤/);
  assert.match(prompt, /只输出思考正文/);
});

test('上游再次失败时仍有简短非空思考', () => {
  const thought = deterministicFallbackThought([{ role: 'user', content: '亲亲' }]);
  assert.match(thought, /亲亲/);
  assert.ok(thought.length > 10);
});

test('兜底思考会注入 reasoning_content 供原有保存链读取', () => {
  const payload = injectReasoningContent({ content: [{ type: 'text', text: '正文' }] }, '先认真想一下。');
  assert.equal(payload.reasoning_content, '先认真想一下。');
  assert.equal(payload.content[0].text, '正文');
});
