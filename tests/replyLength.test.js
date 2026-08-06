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

test('聊天追加自然交流原则、可见思考摘要和柔性长度规则', () => {
  const chat = buildAdaptiveReplyInstruction(300, 'chat');
  assert.match(chat, /【陆泽回复原则】/);
  assert.match(chat, /保持独立思考和真实判断/);
  assert.match(chat, /不要虚构不存在的经历、记忆或事实/);
  assert.match(chat, /【每轮可见思考】/);
  assert.match(chat, /<thinking>/);
  assert.match(chat, /简短思考摘要/);
  assert.match(chat, /不是完整内部推理/);
  assert.match(chat, /【回复长度】/);
  assert.match(chat, /最低长度约为 300 个中文字符/);
  assert.match(chat, /柔性下限，不是目标字数或固定篇幅/);
  assert.match(chat, /不要为了满足长度机械扩写/);
});

test('用户明确要求简短时允许低于下限', () => {
  const chat = buildAdaptiveReplyInstruction(300, 'chat');
  assert.match(chat, /用户明确要求简短时，可以自然低于该下限/);
});

test('共读小屋等事实规则仍然保留', () => {
  const chat = buildAdaptiveReplyInstruction(300, 'chat');
  assert.match(chat, /OurHome 房间与入口认知/);
  assert.match(chat, /共读小屋/);
});

test('最低长度为零时只要求自然完整，不显示数字', () => {
  const chat = buildAdaptiveReplyInstruction(0, 'chat');
  assert.match(chat, /表达完整后意尽而止/);
  assert.doesNotMatch(chat, /最低长度约为/);
});

test('小剧场也把最低长度当作柔性下限', () => {
  const theater = buildAdaptiveReplyInstruction(120, 'theater');
  assert.match(theater, /最低长度约为 120 个中文字符/);
  assert.match(theater, /只推进当前内容，不添加无关背景/);
  assert.match(theater, /不替用户决定尚未表达的感受或选择/);
});
