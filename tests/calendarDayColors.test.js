'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_DAY_COLORS, normalizeCalendarDayColors } = require('../calendarDayColors');

test('calendar colors normalize safe date keys and six-digit hex values', () => {
  assert.deepEqual(normalizeCalendarDayColors({
    '2026-08-09': '#f5dfa0',
    '2026-08-10': '#FFFFFF',
  }), {
    ok: true,
    value: { '2026-08-09': '#F5DFA0', '2026-08-10': '#FFFFFF' },
  });
});

test('calendar colors reject malformed and oversized payloads', () => {
  assert.equal(normalizeCalendarDayColors([]).ok, false);
  assert.equal(normalizeCalendarDayColors({ tomorrow: '#FFFFFF' }).ok, false);
  assert.equal(normalizeCalendarDayColors({ '2026-08-09': 'red' }).ok, false);
  const oversized = Object.fromEntries(Array.from({ length: MAX_DAY_COLORS + 1 }, (_, index) => [`2026-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`, '#FFFFFF']));
  assert.equal(normalizeCalendarDayColors(oversized).ok, false);
});
