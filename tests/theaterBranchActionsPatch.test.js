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
  rowsAfterAnchor,
} = require('../theaterBranchActionsPatch');

const source = fs.readFileSync(path.join(__dirname, '..', 'theaterBranchActionsPatch.js'), 'utf8');

const rows = [
  { id: 'u1', author: '檀' },
  { id: 'a1', author: '泽' },
  { id: 'u2', author: '檀' },
  { id: 'a2', author: '泽' },
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

test('failed edit cleanup prunes only the replacement rows after the saved anchor', () => {
  const activeAfterFailedEdit = [rows[0], rows[1], { id: 'u2-new', author: '檀' }];
  assert.deepEqual(rowsAfterAnchor(activeAfterFailedEdit, 'a1').map(row => row.id), ['u2-new']);
  assert.deepEqual(rowsAfterAnchor(activeAfterFailedEdit, null).map(row => row.id), ['u1', 'a1', 'u2-new']);
  assert.deepEqual(rowsAfterAnchor(activeAfterFailedEdit, 'missing'), []);
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
  assert.match(source, /prune_active_branch/);
  assert.match(source, /rollback\/undo/);
  assert.match(source, /archiveActiveMemory/);
  assert.doesNotMatch(source, /\.delete\s*\(/);
});
