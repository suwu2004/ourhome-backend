'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  recentHistoryCandidateLimit,
  loadRecentVisibleHistory,
  mergeRecentLifeHistory,
} = require('../chatRecentHistory');
const { selectRecentLifeHistory } = require('../chatContextWindow');

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

test('最近历史会扩大候选读取范围，为近三天生活事实留出兜底空间', async () => {
  const descending = Array.from({ length: 420 }, (_, index) => ({
    id: 420 - index,
    role: index % 2 ? 'user' : 'assistant',
    content: `消息 ${420 - index}`,
    created_at: new Date(2026, 0, 1, 0, 420 - index).toISOString(),
  }));
  const supabase = fakeSupabase(descending);
  const recent = await loadRecentVisibleHistory(supabase, 22, { maxRounds: 10, maxTokens: 0 });

  assert.equal(recentHistoryCandidateLimit({ maxRounds: 10 }), 320);
  assert.equal(supabase.calls.find(call => call[0] === 'limit')[1], 320);
  assert.equal(recent.length, 20);
  assert.deepEqual(recent.map(item => item.id), Array.from({ length: 20 }, (_, index) => 401 + index));
  assert.deepEqual(supabase.calls.filter(call => call[0] === 'order').map(call => call[1]), ['created_at', 'id']);
  assert.equal(supabase.calls.some(call => call[0] === 'range'), false);
});

test('重新生成可以多取一条候选消息，同时仍受安全上限约束', () => {
  assert.equal(recentHistoryCandidateLimit({ maxRounds: 20, extraRows: 1 }), 320);
  assert.equal(recentHistoryCandidateLimit({ maxRounds: 900, extraRows: 99 }), 1008);
});

test('最近三天的生活事实会从普通历史之外补回来', () => {
  const now = Date.now();
  const history = [];
  for (let index = 0; index < 100; index += 1) {
    history.push({
      id: `old-${index}`,
      role: index % 2 ? 'user' : 'assistant',
      content: `旧消息 ${index}`,
      created_at: new Date(now - (96 - index) * 60 * 60 * 1000).toISOString(),
    });
  }
  history.push({
    id: 'lunch-yesterday',
    role: 'user',
    content: '昨天中午我吃了番茄鸡蛋面。',
    created_at: new Date(now - 26 * 60 * 60 * 1000).toISOString(),
  });
  history.push({
    id: 'latest',
    role: 'assistant',
    content: '现在正在继续聊天。',
    created_at: new Date(now - 10 * 60 * 60 * 1000).toISOString(),
  });

  const merged = mergeRecentLifeHistory(history, { maxRounds: 10, maxTokens: 5000 });
  assert.equal(merged.some(item => item.id === 'lunch-yesterday'), true);
  assert.match(merged.find(item => item.id === 'lunch-yesterday').content, /历史时间：/);
});

test('更忙的聊天里，夹在大量项目消息中的昨天午饭也会被事实候选单独保留', () => {
  const now = Date.now();
  const history = Array.from({ length: 140 }, (_, index) => ({
    id: `busy-${index}`,
    role: index % 2 ? 'user' : 'assistant',
    content: `项目讨论 ${index}`,
    created_at: new Date(now - (50 - (index * 0.2)) * 60 * 60 * 1000).toISOString(),
  }));
  history.push({
    id: 'important-lunch',
    role: 'user',
    content: '昨天中午我吃了酸辣粉。',
    created_at: new Date(now - 26 * 60 * 60 * 1000).toISOString(),
  });
  history.push(...Array.from({ length: 60 }, (_, index) => ({
    id: `newer-${index}`,
    role: index % 2 ? 'user' : 'assistant',
    content: `后续项目消息 ${index}`,
    created_at: new Date(now - (20 - index * 0.2) * 60 * 60 * 1000).toISOString(),
  })));

  const life = selectRecentLifeHistory(history, { recentHours: 72, maxMessages: 24, factMessages: 8, now });
  assert.equal(life.some(item => item.id === 'important-lunch'), true);
  const merged = mergeRecentLifeHistory(history, { maxRounds: 10, maxTokens: 8000 });
  assert.equal(merged.some(item => item.id === 'important-lunch'), true);
});
