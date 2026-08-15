'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isTheaterMessageQuery,
  parseParentIds,
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
  assert.deepEqual(parseParentIds(theaterUrl('in.(book-a,book-b,book-a)')), ['book-a', 'book-b']);
});

test('loads each Theater book independently so the combined shelf cannot hit the row cap', async () => {
  const rowsByParent = new Map([
    ['book-a', Array.from({ length: 431 }, (_, index) => ({ id: `a-${index + 1}`, parent_id: 'book-a', created_at: new Date(1_000 + index).toISOString() }))],
    ['book-b', Array.from({ length: 294 }, (_, index) => ({ id: `b-${index + 1}`, parent_id: 'book-b', created_at: new Date(2_000 + index).toISOString() }))],
    ['book-c', Array.from({ length: 206 }, (_, index) => ({ id: `c-${index + 1}`, parent_id: 'book-c', created_at: new Date(3_000 + index).toISOString() }))],
    ['book-d', Array.from({ length: 80 }, (_, index) => ({ id: `d-${index + 1}`, parent_id: 'book-d', created_at: new Date(4_000 + index).toISOString() }))],
  ]);
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const parent = String(url.searchParams.get('parent_id') || '').replace(/^eq\./, '');
    calls.push({ parent, range: new Headers(init.headers || undefined).get('Range') });
    const rows = rowsByParent.get(parent) || [];
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const response = await fetchAllTheaterMessageRows(fetchImpl, theaterUrl('in.(book-a,book-b,book-c,book-d)'));
  const result = await response.json();
  assert.equal(result.length, 1011);
  assert.equal(new Set(result.map(row => row.id)).size, 1011);
  assert.deepEqual(calls.map(call => call.parent), ['book-a', 'book-b', 'book-c', 'book-d']);
  assert.ok(calls.every(call => call.range == null));
  assert.equal(response.headers.get('x-ourhome-theater-strategy'), 'per-book');
  assert.equal(response.headers.get('x-ourhome-theater-rows'), '1011');
});

test('an individual Theater book still pages when that book itself exceeds the cap', async () => {
  const rows = Array.from({ length: 1011 }, (_, index) => ({ id: String(index + 1), parent_id: 'book-a', created_at: new Date(index + 1).toISOString() }));
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const headers = new Headers(init.headers || undefined);
    const range = headers.get('Range');
    calls.push(range || 'initial');
    if (!range) return new Response(JSON.stringify(rows.slice(0, 1000)), { status: 200, headers: { 'content-type': 'application/json' } });
    const [from, to] = range.split('-').map(Number);
    return new Response(JSON.stringify(rows.slice(from, to + 1)), { status: 206, headers: { 'content-type': 'application/json' } });
  };

  const response = await fetchAllTheaterMessageRows(fetchImpl, theaterUrl('eq.book-a'));
  const result = await response.json();
  assert.equal(result.length, 1011);
  assert.equal(result.at(-1).id, '1011');
  assert.deepEqual(calls, ['initial', '1000-1999']);
  assert.equal(response.headers.get('x-ourhome-theater-pages'), '2');
});

test('small single-book histories keep the original response without another request', async () => {
  let calls = 0;
  const original = new Response(JSON.stringify([{ id: '1' }]), { status: 200, headers: { etag: 'keep-me' } });
  const response = await fetchAllTheaterMessageRows(async () => { calls += 1; return original; }, theaterUrl('eq.book-a'));
  assert.equal(response, original);
  assert.equal(calls, 1);
  assert.equal(response.headers.get('etag'), 'keep-me');
});
