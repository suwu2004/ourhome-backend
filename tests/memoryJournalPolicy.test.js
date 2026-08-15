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
const { broadenWorkingMemoryList } = require('../memoryLayerPatch');

const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');

test('working memory requires a real summary and an explicit model store decision', () => {
  assert.equal(normalizeJournalMark({ should_store: true, importance: 3 }).shouldStore, false);
  assert.equal(normalizeJournalMark({ summary: '普通对白', should_store: false, importance: 5 }).shouldStore, false);
  assert.equal(normalizeJournalMark({ summary: '这两天早上想喝打发咖啡加牛奶', should_store: true }).shouldStore, true);
  assert.equal(normalizeJournalMark({ summary: '还要完成部署', should_continue: true }).shouldStore, false);
  assert.equal(normalizeJournalMark({ summary: '稳定偏好', should_remember: true }).shouldStore, false);
  assert.equal(normalizeJournalMark({ summary: '还要完成部署', should_continue: true, should_store: true }).shouldStore, true);
});

test('working-memory overview shows stored short-term context without changing Chat continuation injection', () => {
  const overview = 'https://example.supabase.co/rest/v1/memory_marks?select=*&should_continue=eq.true&mark_date=gte.2026-08-01&mark_date=lte.2026-08-15&limit=40';
  const broadened = new URL(broadenWorkingMemoryList(overview));
  assert.equal(broadened.searchParams.has('should_continue'), false);

  const promptRead = 'https://example.supabase.co/rest/v1/memory_marks?select=id%2Ctopic%2Cemotion%2Csummary%2Ctags%2Cimportance%2Ccreated_at&should_continue=eq.true&created_at=gte.2026-08-12T00%3A00%3A00.000Z&limit=8';
  assert.equal(broadenWorkingMemoryList(promptRead), promptRead);
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
