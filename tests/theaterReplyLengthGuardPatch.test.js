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
  assert.equal(body.max_tokens, 556);
});

test('上游过小的 provider token 上限会被提升到小剧场所需预算', () => {
  const body = capProviderTokens(theaterBody(256, 120));
  assert.equal(body.max_tokens, 556);
});

test('已经合理的 provider token 上限也统一到当前小剧场预算', () => {
  const body = capProviderTokens(theaterBody(556, 120));
  assert.equal(body.max_tokens, 556);
});

test('大字数设置仍保留充足的生成空间', () => {
  const body = capProviderTokens(theaterBody(5200, 1500));
  assert.equal(body.max_tokens, 4006);
});

test('非小剧场请求不受影响', () => {
  const body = { model: 'test-model', max_tokens: 2600, system: '普通聊天', messages: [{ role: 'user', content: '你好' }] };
  assert.equal(capProviderTokens(body), body);
});
