'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildChatContextDiagnostics,
  formatChatContextDiagnostics,
} = require('../chatContextDiagnostics');

test('final context diagnostics report context layers without exposing message text', () => {
  const privateText = '早餐是九个小煎包，一份六块钱。';
  const body = {
    model: 'claude-opus-test',
    system: [
      { type: 'text', text: '【最近对话连续性摘录｜接话前必须核对】' },
      { type: 'text', text: '【今日摘要】' },
      { type: 'text', text: '<ourhome_context_ledger>' },
      { type: 'text', text: '<ourhome_current_turn_guard>' },
    ],
    messages: [
      { role: 'user', content: privateText },
      { role: 'assistant', content: '记住了。' },
      { role: 'user', content: '我吃饱了。' },
    ],
    tools: [{ name: 'example' }],
  };

  const report = buildChatContextDiagnostics(body, 'chat');
  const formatted = formatChatContextDiagnostics(report);

  assert.equal(report.messageCount, 3);
  assert.equal(report.lastUserIndex, 2);
  assert.deepEqual(report.tailRoles, ['user', 'assistant', 'user']);
  assert.equal(report.markers.recentContinuity, true);
  assert.equal(report.markers.dailySummary, true);
  assert.equal(report.markers.rollingLedger, true);
  assert.equal(report.markers.currentTurnGuard, true);
  assert.ok(formatted.includes('blocks=recentContinuity,dailySummary,currentTurnGuard,rollingLedger'));
  assert.ok(!formatted.includes(privateText));
  assert.ok(!formatted.includes('我吃饱了'));
});

test('diagnostics handle an empty or non-standard provider payload safely', () => {
  const report = buildChatContextDiagnostics({ model: 'x', system: null, messages: null });
  assert.equal(report.messageCount, 0);
  assert.equal(report.lastUserIndex, -1);
  assert.equal(report.systemChars, 0);
  assert.match(formatChatContextDiagnostics(report), /blocks=none/);
});
