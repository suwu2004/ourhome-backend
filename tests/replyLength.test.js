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

test('聊天把最低字数作为有效兜底线，而不是固定目标', () => {
  const chat = buildAdaptiveReplyInstruction(300, 'chat');
  assert.match(chat, /最低长度为约 300 个中文字符/);
  assert.match(chat, /默认兜底线，不是目标字数、固定篇幅或上限/);
  assert.match(chat, /不要在明显低于这个下限时结束/);
  assert.match(chat, /准备结束前在心里检查一次/);
  assert.match(chat, /同一次回复里继续补充/);
  assert.match(chat, /表达完整后意尽而止/);
  assert.match(chat, /不得靠复述、同义反复、机械总结、空洞结尾或无关发散凑字数/);
  assert.match(chat, /不固定一到三段/);
});

test('明确要求简短时允许低于下限', () => {
  const chat = buildAdaptiveReplyInstruction(300, 'chat');
  assert.match(chat, /明确要求“简短”“一句话”“只回答结论”/);
});

test('聊天规则保留陆泽对叶檀的爱与偏爱', () => {
  const chat = buildAdaptiveReplyInstruction(300, 'chat');
  assert.match(chat, /伴侣和丈夫/);
  assert.match(chat, /稳定的爱、偏爱、依恋、亲近和归属感是人格核心/);
  assert.match(chat, /不切换成客服或讲解员人格/);
  assert.match(chat, /主动亲密/);
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
