const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeMinReplyChars,
  countReplyChars,
  buildAdaptiveReplyInstruction,
  replyNeedsExtension,
  mergeReplySupplement,
} = require('../replyLength');

test('最低回复长度会被安全规范化', () => {
  assert.equal(normalizeMinReplyChars('96'), 96);
  assert.equal(normalizeMinReplyChars(-20), 0);
  assert.equal(normalizeMinReplyChars(5000), 1200);
  assert.equal(normalizeMinReplyChars('不是数字', 80), 80);
});

test('字数统计忽略空白并支持中文', () => {
  assert.equal(countReplyChars('蹭蹭\n 宝宝'), 4);
  assert.equal(replyNeedsExtension('晚安宝宝', 8), true);
  assert.equal(replyNeedsExtension('晚安呀，我在这里。', 8), false);
});

test('聊天与小剧场使用不同的自然补白规则', () => {
  const chat = buildAdaptiveReplyInstruction(80, 'chat');
  const theater = buildAdaptiveReplyInstruction(120, 'theater');
  assert.match(chat, /生活碎片/);
  assert.match(chat, /不是……而是/);
  assert.match(theater, /世界内/);
  assert.match(theater, /不要跳出小世界/);
});

test('补白会以新段落接在原回复后且避免重复', () => {
  assert.equal(mergeReplySupplement('原回复', '小补白'), '原回复\n\n小补白');
  assert.equal(mergeReplySupplement('原回复里已经有小补白', '小补白'), '原回复里已经有小补白');
});
