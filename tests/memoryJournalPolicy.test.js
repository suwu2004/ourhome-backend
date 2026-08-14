'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  WORKING_MEMORY_WINDOW_HOURS,
  normalizeJournalMark,
  workingMemoryCutoff,
} = require('../memoryJournalPolicy');

const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');

test('working memory requires both an explicit continuation signal and a real summary', () => {
  assert.equal(normalizeJournalMark({ should_continue: true, importance: 3 }).shouldStore, false);
  assert.equal(normalizeJournalMark({ summary: '普通对白', importance: 5 }).shouldStore, false);
  assert.equal(normalizeJournalMark({ summary: '还要完成部署', should_continue: true }).shouldStore, true);
});

test('working-memory prompt window stays short while the history remains stored', () => {
  assert.equal(WORKING_MEMORY_WINDOW_HOURS, 72);
  assert.equal(
    workingMemoryCutoff(new Date('2026-08-13T12:00:00.000Z')),
    '2026-08-10T12:00:00.000Z',
  );
  assert.match(server, /gte\('created_at', workingMemoryCutoff\(now\)\)/);
  assert.match(server, /gte\('mark_date', startKey\)/);
  assert.match(server, /lte\('mark_date', date\)/);
});
