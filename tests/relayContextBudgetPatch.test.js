const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_RELAY_CHAT_REQUEST_CHARS, trimOldHistory } = require('../relayContextBudgetPatch');

test('relay Chat 请求过大时只裁掉最早的完整消息对', () => {
  const huge = '中'.repeat(18000);
  const body = {
    model: '[B]claude-opus-5',
    max_tokens: 8192,
    system: '系统',
    messages: [
      { role: 'user', content: '旧消息一'.repeat(3000) },
      { role: 'assistant', content: '旧回复一'.repeat(3000) },
      { role: 'user', content: '当前问题' },
      { role: 'assistant', content: huge },
      { role: 'user', content: '请继续处理当前问题' },
    ],
  };
  const next = trimOldHistory(body);
  assert.ok(JSON.stringify(next).length <= MAX_RELAY_CHAT_REQUEST_CHARS);
  assert.equal(next.messages.at(-1).content, '请继续处理当前问题');
  assert.equal(next.messages.at(-1).role, 'user');
});

test('relay Chat 请求未超限时不改动', () => {
  const body = {
    model: '[B]claude-opus-5',
    max_tokens: 1000,
    system: '系统',
    messages: [{ role: 'user', content: '你好' }],
  };
  assert.strictEqual(trimOldHistory(body), body);
});
