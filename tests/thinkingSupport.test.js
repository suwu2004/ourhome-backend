// 回归测试：只展示模型明确标记为面向用户的简体中文思考摘要。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractThinkingText,
  encodeVisibleThinkingSummary,
  extractBracketedThinking,
  stripThinkingMarkup,
} = require('../thinkingSupport');

test('正文里的模拟 thinking 不进入想一想', () => {
  const result = { content: [{ type: 'text', text: '<thinking>我先确认一下最关键的点。</thinking>\n正式回复。' }] };
  assert.equal(extractThinkingText(result), '');
});

test('中文 reasoning_content 仍视为原始内部推理，不直接展示', () => {
  const result = { reasoning_content: '先核对事实，再给出判断。', content: [{ type: 'text', text: '正式回复。' }] };
  assert.equal(extractThinkingText(result), '');
});

test('Anthropic 原生 thinking block 不直接进入可见思考摘要', () => {
  const result = { content: [{ type: 'thinking', thinking: '这里是模型原生思考。' }, { type: 'text', text: '正式回复。' }] };
  assert.equal(extractThinkingText(result), '');
});

test('原始 reasoning 与正文模拟标签都不会进入可见摘要', () => {
  const result = {
    reasoning_content: '这是原始推理。',
    content: [{ type: 'text', text: '<thinking>这是模拟思考。</thinking>\\n正式回复。' }],
  };
  assert.equal(extractThinkingText(result), '');
});

test('没有中文摘要时不把英文原生 reasoning 展示给用户', () => {
  assert.equal(extractThinkingText({ reasoning_content: 'I should identify the request and respond clearly.' }), '');
});

test('同时返回英文原生 reasoning 和中文可见摘要时优先显示中文摘要', () => {
  const summary = '我先确认她这句话的重点，再用中文简要回应。';
  const result = {
    reasoning_content: 'I should identify the main request and respond clearly.',
    content: [{ type: 'text', text: `【思考摘要开始】${summary}【思考摘要结束】\\n正式回复。` }],
  };
  assert.equal(extractThinkingText(result), summary);
});

test('OpenAI choices 中的 raw reasoning 字段不会被展示', () => {
  const result = { choices: [{ message: { content: '正式回复。', reasoning: '我正在权衡两种做法。' } }] };
  assert.equal(extractThinkingText(result), '');
});

test('reasoning_details 原始字段不会被展示', () => {
  const result = {
    choices: [{ message: { content: '正式回复。', reasoning_details: [{ type: 'reasoning.text', text: '原生 reasoning details。' }] } }],
  };
  assert.equal(extractThinkingText(result), '');
});

test('Gemini thought part 不作为可见摘要展示', () => {
  const result = {
    candidates: [{ content: { parts: [{ thought: true, text: 'Gemini 原生 thought。' }, { text: '正式回复。' }] } }],
  };
  assert.equal(extractThinkingText(result), '');
});

test('兼容 Responses 风格 reasoning output', () => {
  const result = {
    output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: '原生 reasoning summary。' }] }],
  };
  assert.equal(extractThinkingText(result), '原生 reasoning summary。');
});

test('persisted thinking summaries carry an allowlisted marker and raw/empty text cannot be stored', () => {
  assert.equal(
    encodeVisibleThinkingSummary('我先核对问题重点，再给出简短判断。'),
    '【OurHome可见思考摘要v1】\\n我先核对问题重点，再给出简短判断。',
  );
  assert.equal(encodeVisibleThinkingSummary('I should reason step by step.'), null);
  assert.equal(encodeVisibleThinkingSummary(''), null);
});

test('显式 thinking_summary 字段作为可见摘要展示', () => {
  const result = {
    reasoning_content: 'private raw reasoning that should stay hidden',
    thinking_summary: '我先确认当前问题的重点，再简要说明判断依据。',
    content: [{ type: 'text', text: '正式回复。' }],
  };
  assert.equal(extractThinkingText(result), '我先确认当前问题的重点，再简要说明判断依据。');
});

test('显式 reasoning_summary block 作为可见摘要展示', () => {
  const result = {
    content: [
      { type: 'reasoning', text: 'private raw reasoning' },
      { type: 'reasoning_summary', text: '我先核对上下文，再给出清楚的答复。' },
      { type: 'text', text: '正式回复。' },
    ],
  };
  assert.equal(extractThinkingText(result), '我先核对上下文，再给出清楚的答复。');
});

test('Responses reasoning envelope 只读取 summary_text，不读取 raw reasoning', () => {
  const result = {
    output: [{
      type: 'reasoning',
      content: [{ type: 'reasoning_text', text: 'private raw reasoning' }],
      summary: [{ type: 'summary_text', text: '我会先说明最重要的结论。' }],
    }],
  };
  assert.equal(extractThinkingText(result), '我会先说明最重要的结论。');
});

test('英文摘要或只有零星中文字符的混合原文不会进入可见面板', () => {
  assert.equal(extractThinkingText({ thinking_summary: 'I should check the request. 好' }), '');
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

test('提取中转线路返回的可见思考摘要标记', () => {
  const text = '【思考摘要开始】我先确认她真正关心的是这一点，再给出简洁回应。\n【思考摘要结束】\n正式回复。';
  assert.equal(
    extractThinkingText({ content: [{ type: 'text', text }] }),
    '我先确认她真正关心的是这一点，再给出简洁回应。',
  );
  assert.equal(stripThinkingMarkup(text), '正式回复。');
});

test('不把普通正文中的 thinking 标签误当成 provider 思考', () => {
  const text = '<thinking>这只是模型正文里自己写出来的标签。</thinking>\n正式回复。';
  assert.equal(extractThinkingText({ content: [{ type: 'text', text }] }), '');
  assert.equal(stripThinkingMarkup(text), '正式回复。');
});
