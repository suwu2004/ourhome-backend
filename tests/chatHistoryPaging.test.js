'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  encodeChatHistoryCursor,
  parseChatHistoryPaging,
  chatHistoryFetchLimit,
  finalizeChatHistoryPage,
} = require('../chatHistoryPaging');

test('legacy history requests stay unpaged when no limit is supplied', () => {
  assert.equal(parseChatHistoryPaging({}), null);
});

test('paged history clamps page size and decodes an opaque cursor', () => {
  const before = encodeChatHistoryCursor({ createdAt: '2026-08-10T12:00:00.000Z', skip: 2 });
  assert.deepEqual(parseChatHistoryPaging({ limit: '10', before }), {
    limit: 40,
    before: { createdAt: '2026-08-10T12:00:00.000Z', skip: 2 },
  });
  assert.equal(parseChatHistoryPaging({ limit: '9999' }).limit, 500);
  assert.equal(parseChatHistoryPaging({ limit: '240', before: 'broken' }).before, null);
});

test('history page is returned oldest-to-newest with a hasMore marker', () => {
  const rows = [
    { id: 5, created_at: '2026-08-10T12:05:00.000Z' },
    { id: 4, created_at: '2026-08-10T12:04:00.000Z' },
    { id: 3, created_at: '2026-08-10T12:03:00.000Z' },
  ];
  const page = finalizeChatHistoryPage(rows, { limit: 2, before: null });
  assert.deepEqual(page.messages, [rows[1], rows[0]]);
  assert.equal(page.hasMore, true);
  assert.deepEqual(parseChatHistoryPaging({ limit: '40', before: page.nextBefore }).before, {
    createdAt: rows[1].created_at,
    skip: 1,
  });
});

test('cursor skip preserves messages that share the same timestamp across pages', () => {
  const timestamp = '2026-08-10T12:00:00.000Z';
  const firstRows = [
    { id: 'd', created_at: timestamp },
    { id: 'c', created_at: timestamp },
    { id: 'b', created_at: timestamp },
  ];
  const firstPage = finalizeChatHistoryPage(firstRows, { limit: 2, before: null });
  const nextPaging = parseChatHistoryPaging({ limit: '40', before: firstPage.nextBefore });
  assert.equal(nextPaging.before.skip, 2);
  assert.equal(chatHistoryFetchLimit(nextPaging), 43);

  const secondRows = [
    { id: 'd', created_at: timestamp },
    { id: 'c', created_at: timestamp },
    { id: 'b', created_at: timestamp },
    { id: 'a', created_at: timestamp },
    { id: 'older', created_at: '2026-08-10T11:59:00.000Z' },
  ];
  const secondPage = finalizeChatHistoryPage(secondRows, nextPaging);
  assert.equal(secondPage.messages.some(row => row.id === 'b'), true);
  assert.equal(secondPage.messages.some(row => row.id === 'a'), true);
});
