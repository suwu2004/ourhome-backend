const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectRoomScene,
  raiseRoomOutputLimit,
} = require('../roomOutputLimits');

test('悄悄话请求会识别并抬到普通模型 32K 上限', () => {
  const body = {
    model: '[B]claude-opus-4-5',
    max_tokens: 2500,
    messages: [{ role: 'user', content: '请你以陆泽的身份，写一段“悄悄话”，是想悄悄说给叶檀听的话。' }],
  };
  assert.equal(detectRoomScene(body), 'whisper');
  const raised = raiseRoomOutputLimit(body);
  assert.equal(raised.body.max_tokens, 32000);
  assert.equal(raised.requested, 2500);
});

test('幸福日记请求会识别并抬到 PX/CX 64K 上限', () => {
  const body = {
    model: '[PX]claude-opus-4-6',
    max_tokens: 1800,
    messages: [{ role: 'user', content: '请写今天的幸福日记。\n<日记正文>' }],
  };
  assert.equal(detectRoomScene(body), 'happiness_diary');
  assert.equal(raiseRoomOutputLimit(body).body.max_tokens, 64000);
});

test('小剧场生成与续写保留自己的 provider token 预算', () => {
  const standard = {
    model: '[C1]claude-opus-4-6-thinking',
    max_tokens: 176,
    system: 'OurHome 的“小剧场”互动写作引擎\n【篇幅要求】\n本次小剧场回复当前设置的最低长度约为 120 个中文字符。',
    messages: [{ role: 'user', content: '继续写这一章的场景和对白。' }],
  };
  assert.equal(detectRoomScene(standard), 'theater');
  const preserved = raiseRoomOutputLimit(standard);
  assert.equal(preserved.body.max_tokens, 176);
  assert.equal(preserved.scene, 'theater');
  assert.equal(preserved.requested, 176);
  assert.equal(preserved.raisedTo, 176);

  const extended = { ...standard, model: '[CX]claude-opus-4-6', max_tokens: 1832 };
  assert.equal(raiseRoomOutputLimit(extended).body.max_tokens, 1832);
});

test('正式 Chat 通过明确用途抬到模型输出上限', () => {
  const standard = {
    model: '[B]claude-opus-4-5',
    max_tokens: 4000,
    messages: [{ role: 'user', content: '今天想和你多说一会儿。' }],
  };
  assert.equal(detectRoomScene(standard, 'chat'), 'chat');
  assert.equal(raiseRoomOutputLimit(standard, 'chat').body.max_tokens, 32000);

  const extended = { ...standard, model: '[CX]claude-opus-4-6' };
  assert.equal(raiseRoomOutputLimit(extended, 'chat').body.max_tokens, 64000);
});

test('普通聊天和辅助小请求不被强行抬高', () => {
  const body = {
    model: '[B]claude-opus-4-5',
    max_tokens: 520,
    messages: [{ role: 'user', content: '请给这个窗口生成一句简短标题。' }],
  };
  assert.equal(detectRoomScene(body), null);
  const unchanged = raiseRoomOutputLimit(body);
  assert.equal(unchanged.body.max_tokens, 520);
  assert.equal(unchanged.scene, null);
});
