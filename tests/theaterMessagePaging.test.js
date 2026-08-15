'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isTheaterMessageQuery,
  fetchAllTheaterMessageRows,
} = require('../theaterMessagePaging');

function theaterUrl(parent = 'in.(book-a,book-b)') {
  const url = new URL('https://example.supabase.co/rest/v1/letters');
  url.searchParams.set('select', '*');
  url.searchParams.set('category', 'eq.小剧场');
  url.searchParams.set('parent_id', parent);
  url.searchParams.set('order', 'created_at.asc');
  return url.toString();
}

test('detects only unpaged Theater message history reads', () => {
  assert.equal(isTheaterMessageQuery(theaterUrl()), true);
  assert.equal(isTheaterMessageQuery(theaterUrl('eq.book-a')), true);
  assert.equal(isTheaterMessageQuery(theaterUrl(), { headers: { Range: '0-999' } }), false);

  const other = new URL(theaterUrl());
  other.searchParams.set('category', 'eq.小剧本');
  assert.equal(isTheaterMessageQuery(other.toString()), false);
});

test('combines later pages so histories beyond the Supabase row cap stay visible', async () => {
  const rows = Array.from({ length: 1011 }, (_, index) => ({ id: String(index + 1), created_at: index + 1 }));
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const headers = new Headers(init.headers || undefined);
    const range = headers.get('Range');
    calls.push(range || 'initial');
    if (!range) return new Response(JSON.stringify(rows.slice(0, 1000)), { status: 200, headers: { 'content-type': 'application/json' } });
    const [from, to] = range.split('-').map(Number);
    return new Response(JSON.stringify(rows.slice(from, to + 1)), { status: 206, headers: { 'content-type': 'application/json' } });
  };

  const response = await fetchAllTheaterMessageRows(fetchImpl, theaterUrl());
  const result = await response.json();
  assert.equal(result.length, 1011);
  assert.equal(result.at(-1).id, '1011');
  assert.deepEqual(calls, ['initial', '1000-1999']);
  assert.equal(response.headers.get('x-ourhome-theater-pages'), '2');
});

test('small histories keep the original response without another request', async () => {
  let calls = 0;
  const original = new Response(JSON.stringify([{ id: '1' }]), { status: 200, headers: { etag: 'keep-me' } });
  const response = await fetchAllTheaterMessageRows(async () => { calls += 1; return original; }, theaterUrl());
  assert.equal(response, original);
  assert.equal(calls, 1);
  assert.equal(response.headers.get('etag'), 'keep-me');
});
