'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSessionSummaryPrompt,
  normalizeSessionSummaryResult,
  selectRepresentativeMessages,
  selectUsefulText,
} = require('../sessionSummarySinglePass');

test('short histories are included completely and in chronological order', () => {
  const rows = [
    { id: 1, role: 'user', content: '我们今天开始整理 OurHome 的窗口简介。', created_at: '2026-11-01T10:00:00Z' },
    { id: 2, role: 'assistant', content: '我先检查后端实现。', created_at: '2026-11-01T10:01:00Z' },
  ];
  const result = selectRepresentativeMessages(rows);
  assert.equal(result.selected, 2);
  assert.equal(result.omitted, 0);
  assert.equal(result.items[0].speaker, '叶檀');
  assert.equal(result.items[1].speaker, '陆泽');
});

test('long histories are bounded while preserving temporal spread and high-signal decisions', () => {
  const rows = Array.from({ length: 600 }, (_, index) => ({
    id: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: index === 271
      ? '我们决定以后窗口简介更新只调用一次模型，原始聊天记录绝对不能删除。'
      : '普通聊天内容 ' + index + ' ' + '一些日常对话。'.repeat(12),
    created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }));
  const result = selectRepresentativeMessages(rows);
  const serialized = JSON.stringify(result.items);
  assert.equal(result.sampled, true);
  assert.ok(result.selected < rows.length);
  assert.ok(serialized.length <= 10_500);
  assert.match(serialized, /只调用一次模型/);
  assert.match(serialized, /2026-01-01/);
  assert.ok(result.items.at(-1).at > result.items[0].at);
});

test('large historical ledgers are selected by information value, not head truncation', () => {
  const ledger = [
    ...Array.from({ length: 180 }, (_, index) => '[历史时间：2026-01-' + String((index % 28) + 1).padStart(2, '0') + ' 10:00] 叶檀：普通聊天片段 ' + index + '。'),
    '[历史时间：2026-11-03 10:00] 叶檀：明确决定 OurHome 的原始聊天记录永久保留，窗口简介只做增量语义归纳。',
  ].join('\n');
  const result = selectUsefulText(ledger, 1_200);
  assert.ok(result.length <= 1_200);
  assert.match(result, /原始聊天记录永久保留/);
});

test('summary prompt carries existing memory layers without creating another memory system', () => {
  const prompt = buildSessionSummaryPrompt({
    mode: 'incremental',
    sessionName: 'OurHome 记忆优化',
    messages: [{ role: 'user', content: '继续优化窗口简介。' }],
    previousSummary: '旧简介',
    stableMemories: [{ memory_tier: 'core', memory_kind: 'boundary', summary: '原始聊天记录不能删除。', is_protected: true }],
    temporaryMemories: [{ topic: '窗口简介', summary: '正在改成一次模型调用。', importance: 5, should_continue: true }],
    dailySummary: { summary: '今天继续检查窗口简介。', open_threads: ['完成单次调用改造'] },
  });
  assert.match(prompt, /核心/);
  assert.match(prompt, /原始聊天记录不能删除/);
  assert.match(prompt, /正在改成一次模型调用/);
  assert.match(prompt, /增量更新/);
});

test('invalid or truncated summary payloads are rejected before persistence', () => {
  assert.throws(() => normalizeSessionSummaryResult(null), /有效 JSON/);
  assert.throws(() => normalizeSessionSummaryResult({ title: '测试', summary: '太短' }), /有效摘要/);
  const normalized = normalizeSessionSummaryResult({
    title: '窗口简介',
    summary: '这是一个完整的窗口简介，说明了重要背景、已经确认的处理方式以及后续仍需完成的事项。',
    open_threads: ['继续修复', '', '检查部署状态'],
    handoff: '先完成代码测试。',
  });
  assert.equal(normalized.open_threads.length, 2);
});
