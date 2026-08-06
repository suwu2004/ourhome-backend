// 回归测试：聊天只展示模型明确给出的可见思考摘要，不保存完整内部推理。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractThinkingText,
  stripThinkingMarkup,
} = require('../thinkingSupport');

test('提取文本中的可见 thinking 摘要', () => {
  const result = { content: [{ type: 'text', text: '<thinking>我先确认一下最关键的点。</thinking>\n正式回复。' }] };
  assert.equal(extractThinkingText(result), '我先确认一下最关键的点。');
});

test('提取 API 明确返回的 reasoning_summary', () => {
  const result = { reasoning_summary: '先核对事实，再给出判断。', content: [{ type: 'text', text: '正式回复。' }] };
  assert.equal(extractThinkingText(result), '先核对事实，再给出判断。');
});

test('不会把原生完整 reasoning_content 当作可见摘要', () => {
  const result = { reasoning_content: '这里可能是模型完整的内部推理。', content: [{ type: 'text', text: '正式回复。' }] };
  assert.equal(extractThinkingText(result), '');
});

test('不会直接展示 Anthropic 原生 thinking block', () => {
  const result = { content: [{ type: 'thinking', thinking: '完整内部推理。' }, { type: 'text', text: '正式回复。' }] };
  assert.equal(extractThinkingText(result), '');
});

test('兼容多种摘要标签并从正式回复剥离', () => {
  const tagged = '<thinking_summary>第一段摘要。</thinking_summary>\n正式回复。\n<think>第二段摘要。</think>';
  assert.equal(extractThinkingText({ content: [{ type: 'text', text: tagged }] }), '第一段摘要。\n第二段摘要。');
  assert.equal(stripThinkingMarkup(tagged), '正式回复。');
});

test('不会把普通 text block 当成 thinking', () => {
  assert.equal(extractThinkingText({ content: [{ type: 'text', text: '只有正式回复，没有标签。' }] }), '');
});
