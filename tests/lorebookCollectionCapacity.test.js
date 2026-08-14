'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_TOTAL_LOREBOOKS, importCollectionBooks } = require('../lorebookCollectionImport');

test('collection import stops cleanly when the worldbook shelf is full', async () => {
  const existing = Array.from({ length: MAX_TOTAL_LOREBOOKS }, (_, index) => ({
    id: `book-${index}`,
    name: `已有世界书 ${index + 1}`,
    source_name: null,
  }));
  const supabase = {
    from(table) {
      assert.equal(table, 'lorebooks');
      return {
        select: async () => ({ data: existing, error: null }),
      };
    },
  };
  const incoming = [
    { name: '新世界书 A', entry: { name: '完整设定', content: 'A', constant: true } },
    { name: '新世界书 B', entry: { name: '完整设定', content: 'B', constant: true } },
  ];

  const result = await importCollectionBooks(supabase, incoming);
  assert.equal(result.created.length, 0);
  assert.deepEqual(result.skipped, [
    { name: '新世界书 A', reason: 'capacity' },
    { name: '新世界书 B', reason: 'capacity' },
  ]);
});
