'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_MAIN_CHAT_PAYLOAD_CHARS,
  serializedLength,
  trimOldHistory,
} = require('../mainChatPayloadBudget');

test('main chat payload has a bounded final character budget', () => {
  assert.equal(MAX_MAIN_CHAT_PAYLOAD_CHARS, 38_000);
});

test('trims oldest complete chat pairs after hidden context has been added', () => {
  const messages = [];
  for (let index = 0; index < 12; index += 1) {
    messages.push({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `历史第${index}轮：${'旧对话内容'.repeat(120)}`,
    });
  }
  messages.push({ role: 'user', content: 'CURRENT_TURN_KEEP_THIS' });
  const body = {
    model: 'test-model',
    system: '系统与隐藏接续账本'.repeat(120),
    tools: [{ name: 'keep-tool-schema', description: '工具描述'.repeat(60) }],
    messages,
  };
  assert.ok(serializedLength(body) > 8_000);

  const trimmed = trimOldHistory(body, 8_000);
  assert.notEqual(trimmed, body);
  assert.ok(serializedLength(trimmed) <= 8_000);
  assert.equal(trimmed.messages.at(-1).content, 'CURRENT_TURN_KEEP_THIS');
  assert.ok(trimmed.messages.length < body.messages.length);
});

test('does not rewrite payloads already within budget', () => {
  const body = {
    model: 'test-model',
    system: '短系统提示',
    messages: [
      { role: 'user', content: '上一轮' },
      { role: 'assistant', content: '回应' },
      { role: 'user', content: '当前输入' },
    ],
  };
  assert.equal(trimOldHistory(body, 8_000), body);
});

test('does not split an initial tool continuation pair', () => {
  const body = {
    model: 'test-model',
    system: '系统'.repeat(5_000),
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
      { role: 'user', content: '当前输入' },
    ],
  };
  assert.equal(trimOldHistory(body, 8_000), body);
});


test('keeps the human prompt when a tool continuation is appended after it', () => {
  const messages = [];
  for (let index = 0; index < 12; index += 1) {
    messages.push({ role: 'user', content: `旧用户消息 ${index} ${'旧内容'.repeat(100)}` });
    messages.push({ role: 'assistant', content: `旧助手回复 ${index} ${'旧内容'.repeat(100)}` });
  }
  messages.push({ role: 'assistant', content: '上一轮回复'.repeat(80) });
  messages.push({ role: 'user', content: '蝴蝶宝贝' });
  messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'lookup-1', name: 'search', input: {} }] });
  messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'lookup-1', content: '{"ok":true}' }] });

  const body = { model: 'test-model', system: '系统'.repeat(500), tools: [], messages };
  const trimmed = trimOldHistory(body, 8_000);
  const serialized = JSON.stringify(trimmed.messages);
  assert.ok(trimmed !== body);
  assert.ok(serialized.includes('蝴蝶宝贝'));
  assert.ok(serialized.includes('tool_use'));
  assert.ok(serialized.includes('tool_result'));
  assert.ok(!serialized.includes('旧用户消息 0'));
});
