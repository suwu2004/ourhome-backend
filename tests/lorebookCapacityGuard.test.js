'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_LOREBOOKS,
  MAX_ENTRIES_PER_BOOK,
  assertCapacity,
} = require('../lorebookStore');

test('worldbook shelf capacity accepts the last available slot', () => {
  assert.equal(assertCapacity(MAX_LOREBOOKS - 1, 1, MAX_LOREBOOKS, '世界书'), 0);
});

test('worldbook shelf capacity rejects overflow instead of silently exceeding the shelf', () => {
  assert.throws(
    () => assertCapacity(MAX_LOREBOOKS, 1, MAX_LOREBOOKS, '世界书'),
    /世界书最多保存 80 个/,
  );
});

test('entry capacity rejects oversized imports instead of silently truncating after 500 entries', () => {
  assert.throws(
    () => assertCapacity(0, MAX_ENTRIES_PER_BOOK + 1, MAX_ENTRIES_PER_BOOK, '每本世界书的正文条目'),
    /正文条目最多保存 500 个/,
  );
});
