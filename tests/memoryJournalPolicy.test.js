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

test('journal model schema includes the explicit store decision consumed by persistence', () => {
  assert.match(server, /"should_store": true或false/);
  assert.match(server, /should_store 与 should_continue 分开判断/);
});

test('journal persistence checks database write results instead of equating provider success with saved memory', () => {
  assert.match(server, /if \(markError\) persistenceErrors\.push/);
  assert.match(server, /if \(summaryError\) persistenceErrors\.push/);
  assert.match(server, /if \(memoryError\) persistenceErrors\.push/);
  assert.match(server, /记忆日志写入部分失败/);
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

test('memory journal retries one time only when analysis JSON is empty or invalid', () => {
  assert.match(server, /for \(let attempt = 1; attempt <= 2; attempt \+= 1\)/);
  assert.match(server, /empty or invalid JSON analysis; retrying once/);
  assert.match(server, /格式纠正.*合法的 JSON 对象/);
});

test('create_schedule rejects invalid dates and deduplicates same title/time', () => {
  assert.match(server, /if \(!title \|\| !Number\.isFinite\(remindAt\.getTime\(\)\)\)/);
  assert.match(server, /duplicate-check failed/);
  assert.match(server, /\.eq\('title', title\)/);
  assert.match(server, /\.gte\('remind_at', minuteStart\.toISOString\(\)\)/);
  assert.match(server, /\.lt\('remind_at', minuteEnd\.toISOString\(\)\)/);
  assert.match(server, /duplicate: true/);
});

test('chat-created records ignore repeated exact writes within a short window', () => {
  assert.match(server, /async function findRecentActionDuplicate\(table, filters\)/);
  assert.match(server, /Date\.now\(\) - 10 \* 60 \* 1000/);
  assert.match(server, /duplicateWriteResult\('letter_id', duplicateCheck\.duplicate\)/);
  assert.match(server, /duplicateWriteResult\('wish_id', duplicateCheck\.duplicate\)/);
  assert.match(server, /duplicateWriteResult\('entry_id', duplicateCheck\.duplicate\)/);
  for (const action of ["write_diary", "add_wish", "write_whisper", "write_mood_note"]) {
    assert.ok(server.includes("if (name === '" + action + "')"), action + " is guarded");
  }
  assert.match(server, /duplicate-check failed/);
  assert.match(server, /duplicateWriteResult\('favorite_id', duplicateCheck\.duplicate\)/);
  assert.match(server, /memo duplicate-check failed/);
  assert.match(server, /milestone duplicate-check failed/);
  for (const action of ["save_favorite", "manage_home_memo", "manage_milestone"]) {
    assert.ok(server.includes("if (name === '" + action + "')"), action + " is guarded");
  }
});
