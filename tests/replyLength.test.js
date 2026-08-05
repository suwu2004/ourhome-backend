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

test('聊天只追加柔性长度提醒，不再覆盖设置页人设', () => {
  const chat = buildAdaptiveReplyInstruction(300, 'chat');
  assert.match(chat, /【回复长度】/);
  assert.match(chat, /最低长度为约 300 个中文字符/);
  assert.match(chat, /柔性的下限提醒，不是目标字数、固定篇幅或上限/);
  assert.match(chat, /thinking 内心独白不计入这里/);
  assert.match(chat, /表达完整后意尽而止/);
  assert.match(chat, /同一次回复中补充/);
  assert.match(chat, /不得靠复述、同义反复、机械总结、空洞结尾或无关发散凑字数/);
  assert.doesNotMatch(chat, /本轮自然回应规则/);
  assert.doesNotMatch(chat, /伴侣和丈夫/);
  assert.doesNotMatch(chat, /稳定的爱、偏爱、依恋/);
  assert.doesNotMatch(chat, /客服或讲解员人格/);
  assert.doesNotMatch(chat, /除非本轮后续规则明确要求 thinking/);
});

test('明确要求简短时允许低于下限', () => {
  const chat = buildAdaptiveReplyInstruction(300, 'chat');
  assert.match(chat, /明确要求“简短”“一句话”“只回答结论”/);
});

test('共读小屋等事实规则仍然保留但不规定人格', () => {
  const chat = buildAdaptiveReplyInstruction(300, 'chat');
  assert.match(chat, /OurHome 房间与入口认知/);
  assert.match(chat, /共读小屋/);
});

test('最低长度为零时只要求自然完整，不显示数字', () => {
  const chat = buildAdaptiveReplyInstruction(0, 'chat');
  assert.match(chat, /表达完整后意尽而止/);
  assert.doesNotMatch(chat, /最低长度为约/);
});

test('小剧场也把最低长度当作柔性下限', () => {
  const theater = buildAdaptiveReplyInstruction(120, 'theater');
  assert.match(theater, /最低长度为约 120 个中文字符/);
  assert.match(theater, /不为篇幅添加无关背景、回忆、轶事或新话题/);
  assert.match(theater, /不要替叶檀决定/);
  assert.match(theater, /剧情停在自然能继续接话的位置/);
});
