// 回归测试：优先展示模型原生 thinking；原生不存在时读取可见思考标记。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractThinkingText,
  extractBracketedThinking,
  stripThinkingMarkup,
} = require('../thinkingSupport');

test('提取文本中的模拟 thinking', () => {
  const result = { content: [{ type: 'text', text: '<thinking>我先确认一下最关键的点。</thinking>\n正式回复。' }] };
  assert.equal(extractThinkingText(result), '我先确认一下最关键的点。');
});

test('提取 API 返回的 reasoning_content', () => {
  const result = { reasoning_content: '先核对事实，再给出判断。', content: [{ type: 'text', text: '正式回复。' }] };
  assert.equal(extractThinkingText(result), '先核对事实，再给出判断。');
});

test('提取 Anthropic 原生 thinking block', () => {
  const result = { content: [{ type: 'thinking', thinking: '这里是模型原生思考。' }, { type: 'text', text: '正式回复。' }] };
  assert.equal(extractThinkingText(result), '这里是模型原生思考。');
});

test('原生 thinking 优先于正文里的模拟 thinking', () => {
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

test('兼容多种 thinking 标签并从正式回复剥离', () => {
  const tagged = '<thinking_summary>第一段思考。</thinking_summary>\n正式回复。\n<think>第二段思考。</think>';
  assert.equal(extractThinkingText({ content: [{ type: 'text', text: tagged }] }), '第一段思考。\n第二段思考。');
  assert.equal(stripThinkingMarkup(tagged), '正式回复。');
});

test('提取 Gemini 正文里的方括号思考链并从正式回复剥离', () => {
  const text = '[思考链：先接住她在意的点，再自然回应。]\n\n叶檀，我在。';
  assert.deepEqual(extractBracketedThinking(text), ['先接住她在意的点，再自然回应。']);
  assert.equal(extractThinkingText({ choices: [{ message: { content: text } }] }), '先接住她在意的点，再自然回应。');
  assert.equal(stripThinkingMarkup(text), '叶檀，我在。');
});

test('兼容全角和书名号式可见思考标记', () => {
  const text = '［思考过程：这句话很简单，短短想一下就好。］\n【可见思考：再确认语气。】\n正式回复。';
  assert.equal(extractThinkingText({ content: [{ type: 'text', text }] }), '这句话很简单，短短想一下就好。\n再确认语气。');
  assert.equal(stripThinkingMarkup(text), '正式回复。');
});

test('不会把普通 text block 当成 thinking', () => {
  assert.equal(extractThinkingText({ content: [{ type: 'text', text: '只有正式回复，没有标签。' }] }), '');
});
