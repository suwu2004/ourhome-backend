const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  THEATER_MESSAGE_CATEGORY,
  THEATER_HIDDEN_MESSAGE_CATEGORY,
  THEATER_MEMORY_CATEGORY,
  THEATER_ARCHIVED_MEMORY_CATEGORY,
  normalizeMessageIds,
  selectBranchCutRows,
  rowsAtOrAfterCutoff,
} = require('../theaterBranchActionsPatch');

const source = fs.readFileSync(path.join(__dirname, '..', 'theaterBranchActionsPatch.js'), 'utf8');

const rows = [
  { id: 'u1', author: '檀', created_at: '2026-08-16T10:00:00Z' },
  { id: 'a1', author: '泽', created_at: '2026-08-16T10:01:00Z' },
  { id: 'u2', author: '檀', created_at: '2026-08-16T10:02:00Z' },
  { id: 'a2', author: '泽', created_at: '2026-08-16T10:03:00Z' },
];

test('rollback keeps the selected Theater message and hides only later active rows', () => {
  const cut = selectBranchCutRows(rows, 'a1', { includeTarget: false });
  assert.equal(cut.target.id, 'a1');
  assert.deepEqual(cut.rows.map(row => row.id), ['u2', 'a2']);
});

test('edit preparation remembers the previous active anchor and hides target plus future', () => {
  const cut = selectBranchCutRows(rows, 'u2', { includeTarget: true });
  assert.equal(cut.target.author, '檀');
  assert.equal(cut.previous.id, 'a1');
  assert.deepEqual(cut.rows.map(row => row.id), ['u2', 'a2']);
});

test('undo prunes any replacement branch at or after the oldest hidden timestamp', () => {
  const activeAfterFailedEdit = [rows[0], rows[1], { id: 'u2-new', author: '檀', created_at: '2026-08-16T10:04:00Z' }];
  assert.deepEqual(rowsAtOrAfterCutoff(activeAfterFailedEdit, rows[2].created_at).map(row => row.id), ['u2-new']);
  assert.deepEqual(rowsAtOrAfterCutoff(activeAfterFailedEdit, 'bad-date'), []);
});

test('restore ids are deduplicated and bounded without inventing ids', () => {
  assert.deepEqual(normalizeMessageIds(['a1', 'a1', '', null, 'u2']), ['a1', 'u2']);
});

test('Theater branches are reversible archives rather than destructive deletes', () => {
  assert.equal(THEATER_MESSAGE_CATEGORY, '小剧场');
  assert.equal(THEATER_HIDDEN_MESSAGE_CATEGORY, '小剧场·已收起');
  assert.equal(THEATER_MEMORY_CATEGORY, '小剧场记忆');
  assert.equal(THEATER_ARCHIVED_MEMORY_CATEGORY, '小剧场记忆·分支归档');
  assert.match(source, /edit-prepare/);
  assert.match(source, /restoreAnchorId/);
  assert.match(source, /oldest hidden row is the branch boundary/i);
  assert.match(source, /rollback\/undo/);
  assert.match(source, /archiveActiveMemory/);
  assert.doesNotMatch(source, /\.delete\s*\(/);
});
