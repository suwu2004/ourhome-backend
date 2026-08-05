// 回归测试：确保不同 API 站点返回的可见 thinking 都能被 OurHome 保存和展示。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractThinkingText,
  stripThinkingMarkup,
} = require('../thinkingSupport');

test('提取 Anthropic 原生 thinking block', () => {
  const result = { content: [{ type: 'thinking', thinking: '我先停了一下。' }, { type: 'text', text: '正式回复。' }] };
  assert.equal(extractThinkingText(result), '我先停了一下。');
});

test('提取中转站 reasoning_content', () => {
  const result = { content: [{ type: 'text', text: '正式回复。' }], reasoning_content: '这里是中转站返回的内心。' };
  assert.equal(extractThinkingText(result), '这里是中转站返回的内心。');
});

test('提取 OpenAI 兼容 choices 中的 reasoning', () => {
  const result = { choices: [{ message: { content: '正式回复。', reasoning: '我正在犹豫。' } }] };
  assert.equal(extractThinkingText(result), '我正在犹豫。');
});

test('兼容 thinking 与 think 标签并从正式回复剥离', () => {
  const tagged = '<thinking>第一段心声。</thinking>\n正式回复。\n<think>第二段心声。</think>';
  assert.equal(extractThinkingText({ content: [{ type: 'text', text: tagged }] }), '第一段心声。\n第二段心声。');
  assert.equal(stripThinkingMarkup(tagged), '正式回复。');
});

test('不会把普通 text block 当成 thinking', () => {
  assert.equal(extractThinkingText({ content: [{ type: 'text', text: '只有正式回复，没有标签。' }] }), '');
});
