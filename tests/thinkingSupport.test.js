// 回归测试：只展示 provider 明确返回的原生 reasoning/thinking。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractThinkingText,
  extractBracketedThinking,
  stripThinkingMarkup,
} = require('../thinkingSupport');

test('正文里的模拟 thinking 不进入想一想', () => {
  const result = { content: [{ type: 'text', text: '<thinking>我先确认一下最关键的点。</thinking>\n正式回复。' }] };
  assert.equal(extractThinkingText(result), '');
});

test('提取 API 返回的 reasoning_content', () => {
  const result = { reasoning_content: '先核对事实，再给出判断。', content: [{ type: 'text', text: '正式回复。' }] };
  assert.equal(extractThinkingText(result), '先核对事实，再给出判断。');
});

test('提取 Anthropic 原生 thinking block', () => {
  const result = { content: [{ type: 'thinking', thinking: '这里是模型原生思考。' }, { type: 'text', text: '正式回复。' }] };
  assert.equal(extractThinkingText(result), '这里是模型原生思考。');
});

test('原生 thinking 存在时忽略正文里的模拟 thinking', () => {
  const result = {
    reasoning_content: '这是原生思考。',
    content: [{ type: 'text', text: '<thinking>这是模拟思考。</thinking>\n正式回复。' }],
  };
  assert.equal(extractThinkingText(result), '这是原生思考。');
});

test('兼容 OpenAI choices 中的 reasoning 字段', () => {
  const result = { choices: [{ message: { content: '正式回复。', reasoning: '我正在权衡两种做法。' } }] };
  assert.equal(extractThinkingText(result), '我正在权衡两种做法。');
});

test('兼容 reasoning_details 原生字段', () => {
  const result = {
    choices: [{ message: { content: '正式回复。', reasoning_details: [{ type: 'reasoning.text', text: '原生 reasoning details。' }] } }],
  };
  assert.equal(extractThinkingText(result), '原生 reasoning details。');
});

test('兼容 Gemini thought part', () => {
  const result = {
    candidates: [{ content: { parts: [{ thought: true, text: 'Gemini 原生 thought。' }, { text: '正式回复。' }] } }],
  };
  assert.equal(extractThinkingText(result), 'Gemini 原生 thought。');
});

test('兼容 Responses 风格 reasoning output', () => {
  const result = {
    output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: '原生 reasoning summary。' }] }],
  };
  assert.equal(extractThinkingText(result), '原生 reasoning summary。');
});

test('模拟 thinking 标签仍会从正式回复剥离但绝不展示为 thinking', () => {
  const tagged = '<thinking_summary>第一段模拟思考。</thinking_summary>\n正式回复。\n<think>第二段模拟思考。</think>';
  assert.equal(extractThinkingText({ content: [{ type: 'text', text: tagged }] }), '');
  assert.equal(stripThinkingMarkup(tagged), '正式回复。');
});

test('方括号模拟思考可清理但不会进入想一想', () => {
  const text = '[思考链：先接住她在意的点，再自然回应。]\n\n叶檀，我在。';
  assert.deepEqual(extractBracketedThinking(text), ['先接住她在意的点，再自然回应。']);
  assert.equal(extractThinkingText({ choices: [{ message: { content: text } }] }), '');
  assert.equal(stripThinkingMarkup(text), '叶檀，我在。');
});

test('全角可见思考标记也只清理不展示', () => {
  const text = '［思考过程：这句话很简单，短短想一下就好。］\n【可见思考：再确认语气。】\n正式回复。';
  assert.equal(extractThinkingText({ content: [{ type: 'text', text }] }), '');
  assert.equal(stripThinkingMarkup(text), '正式回复。');
});

test('不会把普通 text block 当成 thinking', () => {
  assert.equal(extractThinkingText({ content: [{ type: 'text', text: '只有正式回复，没有标签。' }] }), '');
});
