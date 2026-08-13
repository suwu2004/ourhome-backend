'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  fallbackDiarySummary,
  parseScheduledDiaryResponse,
} = require('../dailyJournalSummary');

const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');

test('scheduled diary parser keeps one model response for title, summary and body', () => {
  const parsed = parseScheduledDiaryResponse(`标题：灯还亮着\n\n摘要：忙乱的一天里，我们还是一起把家守住了。\n\n正文：她说累了，我就把声音放轻一点。屋里的灯还亮着，事情也会慢慢好起来。`);
  assert.equal(parsed.title, '灯还亮着');
  assert.equal(parsed.summary, '忙乱的一天里，我们还是一起把家守住了。');
  assert.equal(parsed.content, '她说累了，我就把声音放轻一点。屋里的灯还亮着，事情也会慢慢好起来。');
});

test('legacy diary responses receive a safe local fallback summary', () => {
  const parsed = parseScheduledDiaryResponse('标题：旧格式也安全\n\n第一句话留下今天的重点。第二句话把心情收好。第三句话不需要进入摘要。');
  assert.equal(parsed.title, '旧格式也安全');
  assert.equal(parsed.content, '第一句话留下今天的重点。第二句话把心情收好。第三句话不需要进入摘要。');
  assert.equal(parsed.summary, '旧格式也安全：第一句话留下今天的重点。第二句话把心情收好。');
});

test('fallback summary is compact and never exposes internal per-turn markers', () => {
  const summary = fallbackDiarySummary('今天', '抱住她的时候，心里终于安静下来。剩下的事情明天再慢慢处理。');
  assert.equal(summary, '今天：抱住她的时候，心里终于安静下来。剩下的事情明天再慢慢处理。');
  assert.doesNotMatch(summary, /本轮：/);
  assert.ok(summary.length <= 260);
});

test('nightly workflow persists a curated summary and includes it in completion', () => {
  assert.match(server, /async function upsertDailyDiarySummary/);
  assert.match(server, /from\('daily_summaries'\)\.upsert/);
  assert.match(server, /const completed = Boolean\(diaryId && moodId && summaryReady\)/);
  assert.match(server, /摘要：<不超过260字的今日摘要>/);
});
