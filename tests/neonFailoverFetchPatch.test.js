'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyFilters,
  applyOrder,
  inferDefaults,
  matchFilter,
  projectRows,
  readWindow,
} = require('../neonFailoverFetchPatch');

test('matches PostgREST scalar, null, range, list, and ilike filters', () => {
  const row = { id: 12, visible: true, parent_id: null, title: 'OurHome 小剧场' };
  assert.equal(matchFilter(row, 'id', 'eq.12'), true);
  assert.equal(matchFilter(row, 'id', 'gte.10'), true);
  assert.equal(matchFilter(row, 'id', 'in.(11,12,13)'), true);
  assert.equal(matchFilter(row, 'parent_id', 'is.null'), true);
  assert.equal(matchFilter(row, 'title', 'ilike.*ourhome*'), true);
});

test('filters, orders, and projects snapshot rows', () => {
  const params = new URLSearchParams('role=eq.user&order=created_at.desc&limit=1&select=id,content');
  const rows = [
    { id: 1, role: 'user', content: 'old', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, role: 'assistant', content: 'reply', created_at: '2026-01-02T00:00:00Z' },
    { id: 3, role: 'user', content: 'new', created_at: '2026-01-03T00:00:00Z' },
  ];
  const filtered = applyFilters(rows, params);
  const ordered = applyOrder(filtered, params.get('order'));
  assert.deepEqual(projectRows(ordered.slice(0, 1), params.get('select')), [{ id: 3, content: 'new' }]);
});

test('a read without limit returns the full snapshot instead of an empty page', () => {
  const unlimited = readWindow(new URLSearchParams('order=updated_at.desc'), new Headers());
  assert.deepEqual(unlimited, { offset: 0, limit: null });

  const explicit = readWindow(new URLSearchParams('offset=5&limit=3'), new Headers());
  assert.deepEqual(explicit, { offset: 5, limit: 3 });

  const ranged = readWindow(new URLSearchParams(), new Headers({ Range: '10-19' }));
  assert.deepEqual(ranged, { offset: 10, limit: 10 });
});

test('infers numeric and UUID ids without mutating input', () => {
  const numeric = inferDefaults({ content: 'hello' }, [{ id: 7, created_at: 'x' }, { id: 9, created_at: 'y' }]);
  assert.equal(numeric.id, 10);
  assert.match(numeric.created_at, /^\d{4}-/);
  const uuid = inferDefaults({ title: 'letter' }, [{ id: '0ddf4fa8-bc42-4e14-9ae7-b02d1309ad75' }]);
  assert.match(uuid.id, /^[0-9a-f-]{36}$/i);
});
