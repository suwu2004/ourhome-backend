const test = require('node:test');
const assert = require('node:assert/strict');
const {
  requestedReplyChars,
  capProviderTokens,
} = require('../theaterReplyLengthGuardPatch');

function theaterBody(max_tokens = 2600, chars = 120) {
  return {
    model: 'test-model',
    max_tokens,
    system: `OurHome 的“小剧场”互动写作引擎\n【篇幅要求】\n本次小剧场回复当前设置的最低长度约为 ${chars} 个中文字符。`,
    messages: [{ role: 'user', content: '继续接着演。' }],
  };
}

test('能从最终 provider 请求识别小剧场字数设置', () => {
  assert.equal(requestedReplyChars(theaterBody(2600, 300)), 300);
});

test('小剧场不会再被 2600 token 的固定下限放大', () => {
  const body = capProviderTokens(theaterBody(2600, 120));
  assert.equal(body.max_tokens, 190);
});

test('已经合理的 provider token 上限不会被二次压低', () => {
  const body = capProviderTokens(theaterBody(190, 120));
  assert.equal(body.max_tokens, 190);
});

test('大字数设置仍保留合理的生成空间', () => {
  const body = capProviderTokens(theaterBody(5200, 1500));
  assert.equal(body.max_tokens, 1915);
});

test('非小剧场请求不受影响', () => {
  const body = { model: 'test-model', max_tokens: 2600, system: '普通聊天', messages: [{ role: 'user', content: '你好' }] };
  assert.equal(capProviderTokens(body), body);
});
