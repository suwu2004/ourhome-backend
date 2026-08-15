'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isFullVisibleChatHistoryQuery,
  fetchAllChatHistoryRows,
} = require('../chatFullHistoryPaging');

function chatUrl({ limit } = {}) {
  const url = new URL('https://example.supabase.co/rest/v1/messages');
  url.searchParams.set('select', '*');
  url.searchParams.set('session_id', 'eq.7');
  url.searchParams.set('visible', 'eq.true');
  url.searchParams.set('order', 'created_at.asc');
  if (limit != null) url.searchParams.set('limit', String(limit));
  return url.toString();
}

test('targets only legacy full visible Chat history reads', () => {
  assert.equal(isFullVisibleChatHistoryQuery(chatUrl()), true);
  assert.equal(isFullVisibleChatHistoryQuery(chatUrl({ limit: 241 })), false);
  assert.equal(isFullVisibleChatHistoryQuery(chatUrl(), { headers: { Range: '0-999' } }), false);

  const hidden = new URL(chatUrl());
  hidden.searchParams.set('visible', 'eq.false');
  assert.equal(isFullVisibleChatHistoryQuery(hidden.toString()), false);
});

test('full Chat history reads combine later pages without duplicating rows', async () => {
  const rows = Array.from({ length: 1013 }, (_, index) => ({
    id: index + 1,
    session_id: 7,
    visible: true,
    created_at: new Date(index + 1).toISOString(),
  }));
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const range = new Headers(init.headers || undefined).get('Range');
    calls.push(range || 'initial');
    if (!range) return new Response(JSON.stringify(rows.slice(0, 1000)), { status: 200, headers: { 'content-type': 'application/json' } });
    const [from, to] = range.split('-').map(Number);
    return new Response(JSON.stringify(rows.slice(from, to + 1)), { status: 206, headers: { 'content-type': 'application/json' } });
  };

  const response = await fetchAllChatHistoryRows(fetchImpl, chatUrl());
  const result = await response.json();
  assert.equal(result.length, 1013);
  assert.equal(result[0].id, 1);
  assert.equal(result.at(-1).id, 1013);
  assert.deepEqual(calls, ['initial', '1000-1999']);
  assert.equal(response.headers.get('x-ourhome-chat-pages'), '2');
  assert.equal(response.headers.get('x-ourhome-chat-rows'), '1013');
});
