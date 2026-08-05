const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeMinReplyChars,
  buildAdaptiveReplyInstruction,
} = require('../replyLength');

test('最低回复长度设置仍会被安全规范化', () => {
  assert.equal(normalizeMinReplyChars('96'), 96);
  assert.equal(normalizeMinReplyChars(-20), 0);
  assert.equal(normalizeMinReplyChars(5000), 1200);
  assert.equal(normalizeMinReplyChars('不是数字', 80), 80);
});

test('聊天保留长度设置，但不再把最低字数写进提示词', () => {
  const chat = buildAdaptiveReplyInstruction(300, 'chat');
  assert.match(chat, /不设最低字数/);
  assert.match(chat, /不固定一到三段/);
  assert.match(chat, /技术、工作和普通信息时，优先准确、清楚/);
  assert.match(chat, /不把每次回复都写成固定的抱抱、亲亲/);
  assert.match(chat, /除非本轮后续规则明确要求 thinking/);
  assert.doesNotMatch(chat, /300/);
  assert.doesNotMatch(chat, /字左右作为最低篇幅目标/);
  assert.doesNotMatch(chat, /为了凑字数/);
});

test('小剧场不再收到最低字数提示，也不靠无关补白凑篇幅', () => {
  const theater = buildAdaptiveReplyInstruction(120, 'theater');
  assert.match(theater, /不设最低字数/);
  assert.match(theater, /不为篇幅添加无关背景、回忆、轶事或新话题/);
  assert.match(theater, /不替叶檀决定/);
  assert.doesNotMatch(theater, /120/);
  assert.doesNotMatch(theater, /字左右作为最低篇幅目标/);
});
