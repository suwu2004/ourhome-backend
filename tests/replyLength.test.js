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

test('聊天与小剧场都只延续当前内容，不用无关内容凑字', () => {
  const chat = buildAdaptiveReplyInstruction(80, 'chat');
  const theater = buildAdaptiveReplyInstruction(120, 'theater');
  assert.match(chat, /只把对方这一轮/);
  assert.match(chat, /不偏离当前话题/);
  assert.match(chat, /不引入这一轮未提及/);
  assert.match(chat, /不是……而是/);
  assert.match(theater, /当前正在发生/);
  assert.match(theater, /不要为了凑字数/);
  assert.doesNotMatch(chat, /松散话题|题外话/);
  assert.doesNotMatch(theater, /环境余响/);
});

test('补白会以新段落接在原回复后且避免重复', () => {
  assert.equal(mergeReplySupplement('原回复', '小补白'), '原回复\n\n小补白');
  assert.equal(mergeReplySupplement('原回复里已经有小补白', '小补白'), '原回复里已经有小补白');
});
