const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MIN_RATIO,
  MAX_FINAL_RATIO,
  requestedReplyChars,
  isTheaterBody,
  extractText,
  continuationBody,
} = require('../theaterMinimumReplyPatch');

function theaterBody(chars = 1000) {
  return {
    model: 'test-model',
    max_tokens: 3000,
    system: `OurHome 的“小剧场”互动写作引擎\n【篇幅要求】\n本次小剧场回复当前设置的最低长度约为 ${chars} 个中文字符。`,
    messages: [{ role: 'user', content: '继续。' }],
  };
}

test('识别小剧场的实际字数设置', () => {
  assert.equal(requestedReplyChars(theaterBody(1200)), 1200);
  assert.equal(isTheaterBody(theaterBody(1200)), true);
});

test('普通聊天不会触发小剧场长度补写', () => {
  assert.equal(isTheaterBody({ system: '普通聊天', messages: [{ role: 'user', content: '你好' }] }), false);
});

test('续写请求保留原剧情并明确剩余字数', () => {
  const body = theaterBody(1000);
  const next = continuationBody(body, '第一段。', 999);
  assert.equal(next.messages.length, 3);
  assert.equal(next.messages[1].role, 'assistant');
  assert.match(next.messages[2].content, /至少约 999 个字符/u);
  assert.ok(next.max_tokens >= 256);
});

test('抽取 OpenAI 与 Anthropic 文本', () => {
  assert.equal(extractText({ choices: [{ message: { content: '你好' } }] }), '你好');
  assert.equal(extractText({ content: [{ type: 'text', text: '你好' }] }), '你好');
});

test('补写阈值和最终上限保持在设定附近', () => {
  assert.equal(MIN_RATIO, 0.95);
  assert.equal(MAX_FINAL_RATIO, 1.10);
});
