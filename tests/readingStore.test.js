const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReadingText, splitReadingText, normalizeProgress } = require('../readingStore');

test('期待回信这类日期文本会按日期拆分，并保留原文标题行', () => {
  const text = `期待回信\n2026/2/14/  天气晴（天空蓝蓝的）\n陆泽宝宝好～\n今天是情人节。\n2026/2/15\n今天也写一点。\n2026/3/7 纪念日\n第三篇。`;
  const parsed = splitReadingText(text, '期待回信.txt');
  assert.equal(parsed.title, '期待回信');
  assert.equal(parsed.split_mode, 'date');
  assert.equal(parsed.chapter_count, 4);
  assert.equal(parsed.chapters[0].title, '写在前面');
  assert.equal(parsed.chapters[1].title, '2026/2/14/  天气晴（天空蓝蓝的）');
  assert.match(parsed.chapters[1].content, /^2026\/2\/14/);
  assert.match(parsed.chapters[1].content, /陆泽宝宝好/);
  assert.equal(parsed.chapters[3].title, '2026/3/7 纪念日');
});

test('普通小说会按章节标题拆分，但不会把正文首句误当标题', () => {
  const text = `小书\n第一章 风起\n第一章正文。\n第二章 夜雨\n第二章正文。\n第三章 回家\n第三章正文。`;
  const parsed = splitReadingText(text, '小书.txt');
  assert.equal(parsed.split_mode, 'chapter');
  assert.equal(parsed.chapter_count, 4);
  assert.equal(parsed.chapters[1].title, '第一章 风起');
  assert.match(parsed.chapters[1].content, /第一章正文/);
  assert.equal(parsed.chapters[2].title, '第二章 夜雨');
  assert.match(parsed.chapters[2].content, /第二章正文/);
});

test('没有可靠标题时完整保留为单篇', () => {
  const parsed = splitReadingText('只有一段文字。\n没有章节标题。', '随笔.txt');
  assert.equal(parsed.title, '只有一段文字。');
  assert.equal(parsed.split_mode, 'single');
  assert.equal(parsed.chapter_count, 1);
  assert.equal(parsed.chapters[0].content, '只有一段文字。\n没有章节标题。');
});

test('文本规范化只清理编码痕迹，不改写正文', () => {
  assert.equal(normalizeReadingText('\uFEFF第一行\r\n第二行  \r\n'), '第一行\n第二行');
});

test('阅读进度会被限制在安全范围', () => {
  const progress = normalizeProgress({ chapter_index: -3, paragraph_index: 7.8, char_offset: 12.4, progress_percent: 120 });
  assert.equal(progress.chapter_index, 0);
  assert.equal(progress.paragraph_index, 8);
  assert.equal(progress.char_offset, 12);
  assert.equal(progress.progress_percent, 100);
});
