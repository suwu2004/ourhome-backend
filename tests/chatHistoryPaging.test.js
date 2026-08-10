'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseChatHistoryPaging,
  finalizeChatHistoryPage,
} = require('../chatHistoryPaging');

test('legacy history requests stay unpaged when no limit is supplied', () => {
  assert.equal(parseChatHistoryPaging({}), null);
});

test('paged history clamps page size and preserves an optional cursor', () => {
  assert.deepEqual(parseChatHistoryPaging({ limit: '10', before: '2026-08-10T12:00:00.000Z' }), {
    limit: 40,
    before: '2026-08-10T12:00:00.000Z',
  });
  assert.equal(parseChatHistoryPaging({ limit: '9999' }).limit, 500);
});

test('history page is returned oldest-to-newest with a hasMore marker', () => {
  const rows = [
    { id: 5, created_at: '2026-08-10T12:05:00.000Z' },
    { id: 4, created_at: '2026-08-10T12:04:00.000Z' },
    { id: 3, created_at: '2026-08-10T12:03:00.000Z' },
  ];
  assert.deepEqual(finalizeChatHistoryPage(rows, 2), {
    messages: [rows[1], rows[0]],
    hasMore: true,
    nextBefore: rows[1].created_at,
  });
});
