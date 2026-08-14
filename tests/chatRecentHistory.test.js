'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  recentHistoryCandidateLimit,
  loadRecentVisibleHistory,
} = require('../chatRecentHistory');

function fakeSupabase(rows) {
  const calls = [];
  const chain = {
    select(value) { calls.push(['select', value]); return this; },
    eq(column, value) { calls.push(['eq', column, value]); return this; },
    order(column, options) { calls.push(['order', column, options]); return this; },
    async limit(value) {
      calls.push(['limit', value]);
      return { data: rows.slice(0, value), error: null };
    },
  };
  return {
    calls,
    from(table) {
      calls.push(['from', table]);
      return chain;
    },
  };
}

test('最近历史查询只读取轮数上限内的尾部消息', async () => {
  const descending = Array.from({ length: 80 }, (_, index) => ({
    id: 80 - index,
    role: index % 2 ? 'user' : 'assistant',
    content: `消息 ${80 - index}`,
    created_at: new Date(2026, 0, 1, 0, 80 - index).toISOString(),
  }));
  const supabase = fakeSupabase(descending);
  const recent = await loadRecentVisibleHistory(supabase, 22, { maxRounds: 10, maxTokens: 0 });

  assert.equal(recentHistoryCandidateLimit({ maxRounds: 10 }), 20);
  assert.equal(supabase.calls.find(call => call[0] === 'limit')[1], 20);
  assert.deepEqual(recent.map(item => item.id), Array.from({ length: 20 }, (_, index) => 61 + index));
  assert.deepEqual(supabase.calls.filter(call => call[0] === 'order').map(call => call[1]), ['created_at', 'id']);
  assert.equal(supabase.calls.some(call => call[0] === 'range'), false);
});

test('重新生成可以多取一条候选消息，同时仍受安全上限约束', () => {
  assert.equal(recentHistoryCandidateLimit({ maxRounds: 20, extraRows: 1 }), 41);
  assert.equal(recentHistoryCandidateLimit({ maxRounds: 900, extraRows: 99 }), 1008);
});
