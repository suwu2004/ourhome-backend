const test = require('node:test');
const assert = require('node:assert/strict');
const {
  requestedReplyChars,
  trimAtNaturalBoundary,
  capAssistantInsert,
  remember,
} = require('../theaterReplyHardCapPatch');

test('reads the configured Theater character budget from the prompt', () => {
  const body = {
    system: 'OurHome 的“小剧场”互动写作引擎。\n本次小剧场回复当前设置的最低长度约为 320 个中文字符。',
    messages: [{ role: 'user', content: '继续。' }],
  };
  assert.equal(requestedReplyChars(body), 320);
});

test('trims long Theater output at a natural sentence boundary', () => {
  const text = '第一句内容。第二句内容。第三句内容。第四句内容。第五句内容。第六句内容。';
  const trimmed = trimAtNaturalBoundary(text, 20);
  assert.ok(trimmed.length <= 20);
  assert.match(trimmed, /[。！？；…]$/u);
});

test('caps persisted Theater assistant content while preserving reasoning metadata', () => {
  const original = '这是很长的一段小剧场回复。'.repeat(40);
  remember(original, 60);
  const result = capAssistantInsert({ category: '小剧场', author: '泽', content: original, reasoning_content: '原生思考' });
  assert.ok(result.content.length <= 60);
  assert.equal(result.content, trimAtNaturalBoundary(original, 60));
});

test('does not alter unrelated message categories', () => {
  const body = { category: '小剧本', author: '泽', content: 'x'.repeat(500) };
  remember(body.content, 20);
  assert.deepEqual(capAssistantInsert(body), body);
});
