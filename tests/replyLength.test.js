const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeMinReplyChars,
  buildAdaptiveReplyInstruction,
} = require('../replyLength');

test('最低回复长度会被安全规范化', () => {
  assert.equal(normalizeMinReplyChars('96'), 96);
  assert.equal(normalizeMinReplyChars(-20), 0);
  assert.equal(normalizeMinReplyChars(5000), 1200);
  assert.equal(normalizeMinReplyChars('不是数字', 80), 80);
});

test('最低长度只作为单次回复目标，不触发补话', () => {
  const chat = buildAdaptiveReplyInstruction(80, 'chat');
  const theater = buildAdaptiveReplyInstruction(120, 'theater');
  assert.match(chat, /可以短一些，不必硬凑/);
  assert.match(chat, /回复一次说完/);
  assert.match(chat, /“其实”“另外”“顺便”/);
  assert.match(chat, /只围绕对方这一轮/);
  assert.match(chat, /不偏离当前话题/);
  assert.match(chat, /不引入这一轮未提及/);
  assert.match(chat, /不是……而是/);
  assert.match(theater, /只围绕当前正在发生/);
  assert.doesNotMatch(chat, /松散话题|题外话|生活碎片/);
  assert.doesNotMatch(theater, /环境余响|补白/);
});
