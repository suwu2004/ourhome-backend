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


test('relay cap preserves the latest human prompt before a tool-result tail', () => {
  const messages = [];
  for (let index = 0; index < 20; index += 1) {
    messages.push({ role: 'user', content: `旧用户消息 ${index} ${'旧内容'.repeat(1600)}` });
    messages.push({ role: 'assistant', content: `旧助手回复 ${index} ${'旧内容'.repeat(1600)}` });
  }
  messages.push({ role: 'assistant', content: '上一轮助手回复' });
  messages.push({ role: 'user', content: '蝴蝶宝贝' });
  messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'lookup-1', name: 'search', input: {} }] });
  messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'lookup-1', content: '{"ok":true}' }] });
  const body = { model: '[B]claude-opus-4-5', max_tokens: 8192, system: '系统', messages };

  const trimmed = trimOldHistory(body);
  const serialized = JSON.stringify(trimmed.messages);
  assert.ok(JSON.stringify(trimmed).length <= MAX_RELAY_CHAT_REQUEST_CHARS);
  assert.ok(serialized.includes('蝴蝶宝贝'));
  assert.ok(serialized.includes('tool_use'));
  assert.ok(serialized.includes('tool_result'));
  assert.ok(!serialized.includes('旧用户消息 0'));
});
