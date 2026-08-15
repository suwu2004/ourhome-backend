'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  THREAD_WINDOW_MS,
  EXACT_THREAD_WINDOW_MS,
  workingMemoryThreadMatch,
  findWorkingMemoryThreadMatch,
  mergeWorkingMemoryThread,
} = require('../workingMemoryThreadDedupe');

function mark(overrides = {}) {
  return {
    id: 'keeper-1',
    message_id: '100',
    session_id: '22',
    mark_date: '2026-08-15',
    role: 'user',
    topic: '模型切换站点固定模型问题',
    summary: '站点一固定模型A，切换站点后才会换成另一个站点自己的固定模型。',
    tags: ['OurHome', '模型'],
    importance: 3,
    should_continue: true,
    should_remember: true,
    status: 'active',
    metadata: { assistant_message_id: '101' },
    reinforcement_count: 0,
    created_at: '2026-08-15T09:00:00.000Z',
    updated_at: '2026-08-15T09:00:00.000Z',
    ...overrides,
  };
}

test('同一会话短时间内继续推进同一主题时滚动更新而不是再记一条', () => {
  const existing = mark();
  const candidate = mark({
    id: undefined,
    message_id: '102',
    topic: '模型切换规则继续确认',
    summary: '继续确认每个 API 站点各自固定一个模型，切换站点才切换到对应模型。',
    updated_at: undefined,
    created_at: undefined,
  });
  const reason = workingMemoryThreadMatch(candidate, existing, Date.parse('2026-08-15T09:20:00.000Z'));
  assert.ok(reason?.startsWith('rolling-'));
});

test('同一会话里相邻但不同的话题不会被误合并', () => {
  const existing = mark();
  const candidate = mark({
    message_id: '103',
    topic: '午饭和快递',
    summary: '中午准备吃米饭，吃完下楼拿一个快递。',
  });
  assert.equal(
    workingMemoryThreadMatch(candidate, existing, Date.parse('2026-08-15T09:20:00.000Z')),
    null,
  );
});

test('稳定 topic 的真实后续在 72 小时工作记忆窗口内继续更新原记录', () => {
  const existing = mark({ topic: 'API站点固定模型' });
  const candidate = mark({
    message_id: '104',
    topic: 'API站点固定模型',
    summary: '后续确认站点二改为 Gemini，其他站点规则不变。',
  });
  assert.equal(
    workingMemoryThreadMatch(candidate, existing, Date.parse('2026-08-15T15:00:00.000Z')),
    'same-topic',
  );
});

test('换了 Chat 会话后，同一稳定 topic 的后续仍更新原临时记忆', () => {
  const existing = mark({ topic: 'API站点固定模型', session_id: '22' });
  const candidate = mark({
    message_id: '204',
    session_id: '99',
    topic: 'API站点固定模型',
    summary: '新窗口继续确认站点二改为 Gemini，原来的规则继续有效。',
  });
  assert.equal(
    workingMemoryThreadMatch(candidate, existing, Date.parse('2026-08-15T15:00:00.000Z')),
    'same-topic-cross-session',
  );
});

test('换会话后的完全相同事实不会再新增一条', () => {
  const existing = mark({ session_id: '22' });
  const candidate = mark({ message_id: '205', session_id: '99' });
  assert.equal(
    workingMemoryThreadMatch(candidate, existing, Date.parse('2026-08-15T10:00:00.000Z')),
    'exact-summary',
  );
});

test('跨会话只允许精确事实或稳定 topic 合并，不做模糊猜测', () => {
  const existing = mark({ session_id: '22' });
  const candidate = mark({
    message_id: '206',
    session_id: '99',
    topic: '模型切换规则继续确认',
    summary: '继续讨论另一个模型页面的按钮位置和显示方式。',
  });
  assert.equal(
    workingMemoryThreadMatch(candidate, existing, Date.parse('2026-08-15T09:20:00.000Z')),
    null,
  );
});

test('模糊相似只在短滚动窗口内合并，避免几小时后的不同状态乱并', () => {
  const existing = mark();
  const candidate = mark({
    message_id: '105',
    topic: '模型切换规则继续确认',
    summary: '继续讨论另一个模型页面的按钮位置和显示方式。',
  });
  assert.equal(
    workingMemoryThreadMatch(candidate, existing, Date.parse('2026-08-15T09:00:00.000Z') + THREAD_WINDOW_MS + 1),
    null,
  );
});

test('超过 72 小时后同名 topic 也允许形成新的工作记忆周期', () => {
  const existing = mark();
  const candidate = mark({ message_id: '106', topic: existing.topic, summary: existing.summary + '三天后又重新讨论。' });
  assert.equal(
    workingMemoryThreadMatch(candidate, existing, Date.parse('2026-08-15T09:00:00.000Z') + EXACT_THREAD_WINDOW_MS + 1),
    null,
  );
});

test('滚动记忆保留最新状态并允许待续事项自然收尾', () => {
  const existing = mark();
  const candidate = mark({
    message_id: '107',
    topic: '模型切换修复完成',
    summary: '站点切换已经验证正常，这个问题处理完了。',
    importance: 4,
    should_continue: false,
    should_remember: false,
    tags: ['修复'],
    metadata: { assistant_message_id: '108' },
  });
  const merged = mergeWorkingMemoryThread(existing, candidate, {
    reason: 'rolling-topic',
    now: new Date('2026-08-15T09:30:00.000Z'),
  });
  assert.equal(merged.message_id, '107');
  assert.equal(merged.summary, candidate.summary);
  assert.equal(merged.should_continue, false);
  assert.equal(merged.should_remember, true);
  assert.equal(merged.importance, 4);
  assert.equal(merged.reinforcement_count, 1);
  assert.equal(merged.metadata.first_message_id, '100');
  assert.equal(merged.metadata.last_message_id, '107');
  assert.equal(merged.metadata.merged_turn_count, 2);
  assert.equal(merged.metadata.working_memory_rollup, 'rolling-thread-v3-cross-session');
});

test('异步整理较旧消息晚到时不会倒退覆盖较新的临时状态', () => {
  const existing = mark({
    message_id: '110',
    summary: '较新的状态：问题已经解决。',
    should_continue: false,
    metadata: { first_message_id: '100', last_message_id: '110', merged_turn_count: 4 },
  });
  const lateOlderCandidate = mark({
    message_id: '108',
    summary: '较旧的状态：还在排查问题。',
    should_continue: true,
  });
  const merged = mergeWorkingMemoryThread(existing, lateOlderCandidate, {
    reason: 'rolling-details',
    now: new Date('2026-08-15T09:40:00.000Z'),
  });
  assert.equal(merged.message_id, '110');
  assert.equal(merged.summary, existing.summary);
  assert.equal(merged.should_continue, false);
  assert.match(merged.metadata.merge_reason, /stale-source/);
});

test('同一消息重试不会增加重复整理次数', () => {
  const existing = mark({
    metadata: { first_message_id: '100', last_message_id: '100', merged_turn_count: 1 },
    reinforcement_count: 2,
  });
  const candidate = mark({ summary: '同一来源重新得到的摘要。' });
  const match = findWorkingMemoryThreadMatch(candidate, [existing], Date.parse('2026-08-15T09:10:00.000Z'));
  assert.equal(match.reason, 'same-source');
  const merged = mergeWorkingMemoryThread(existing, candidate, { reason: match.reason, now: new Date('2026-08-15T09:10:00.000Z') });
  assert.equal(merged.reinforcement_count, 2);
  assert.equal(merged.metadata.merged_turn_count, 1);
});

test('运行时只对自动 memory-journal 写入做滚动整理，并跨会话检查精确重复', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'memoryLayerPatch.js'), 'utf8');
  assert.match(source, /candidate\.metadata\?\.assistant_message_id/);
  assert.match(source, /findWorkingMemoryThreadMatch/);
  assert.match(source, /EXACT_THREAD_WINDOW_MS/);
  assert.doesNotMatch(source, /parsed\.searchParams\.set\('session_id'/);
  assert.match(source, /serializeWorkingMemoryWrite\('journal-global'/);
  assert.match(source, /working_memory_dedup: 'rolling-thread-v3-cross-session'/);
  assert.match(source, /keeping normal insert/);
});
