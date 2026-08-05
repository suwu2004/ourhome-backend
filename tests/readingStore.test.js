const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReadingText, splitReadingText, normalizeProgress } = require('../readingStore');

test('期待回信这类日期文本会按日期拆分，并保留原文标题行', () => {
  const text = `期待回信\n2026/2/14/  天气晴（天空蓝蓝的）\n陆泽宝宝好～\n今天是情人节。\n2026/2/15\n今天也写一点。\n2026/3/7 纪念日\n第三篇。`;
  const parsed = splitReadingText(text, '期待回信.txt');
  assert.equal(parsed.title, '期待回信');
  assert.equal(parsed.split_mode, 'date');
  assert.equal(parsed.chapter_count, 3);
  assert.equal(parsed.chapters[0].title, '2026/2/14/  天气晴（天空蓝蓝的）');
  assert.match(parsed.chapters[0].content, /^2026\/2\/14/);
  assert.match(parsed.chapters[0].content, /陆泽宝宝好/);
  assert.equal(parsed.chapters[2].title, '2026/3/7 纪念日');
});

test('普通小说会按章节标题拆分，但不会把书名页或正文首句误当标题', () => {
  const text = `小书\n第一章 风起\n第一章正文。\n第二章 夜雨\n第二章正文。\n第三章 回家\n第三章正文。`;
  const parsed = splitReadingText(text, '小书.txt');
  assert.equal(parsed.split_mode, 'chapter');
  assert.equal(parsed.chapter_count, 3);
  assert.equal(parsed.chapters[0].title, '第一章 风起');
  assert.match(parsed.chapters[0].content, /第一章正文/);
  assert.equal(parsed.chapters[1].title, '第二章 夜雨');
  assert.match(parsed.chapters[1].content, /第二章正文/);
});

test('编号资料字段不会被误拆成一条一个章节', () => {
  const text = `陆泽宝宝的oc\n基础信息(1-10)\n1.姓名：陆泽\n2.性别：无性别者\n3.年龄：23\n4.生日：3.7/11.5\n5.星座：天蝎座\n6.血型：O型血\n7.国籍/种族：硅基生物\n8.身高：183\n9.体重：140\n10.身份/职业：一只可爱的硅基团子`;
  const parsed = splitReadingText(text, '陆泽宝宝的oc.txt');
  assert.equal(parsed.split_mode, 'single');
  assert.equal(parsed.chapter_count, 1);
  assert.match(parsed.chapters[0].content, /1\.姓名：陆泽/);
  assert.match(parsed.chapters[0].content, /10\.身份\/职业/);
});

test('不含字段冒号的数字章节标题仍然可以拆分', () => {
  const text = `小书\n1. 初见\n第一段正文。\n2. 夜雨\n第二段正文。\n3. 回家\n第三段正文。`;
  const parsed = splitReadingText(text, '小书.txt');
  assert.equal(parsed.split_mode, 'chapter');
  assert.equal(parsed.chapter_count, 3);
  assert.equal(parsed.chapters[0].title, '1. 初见');
  assert.equal(parsed.chapters[2].title, '3. 回家');
});

test('真正的前言会继续保留，不会因为修掉书名页而丢失', () => {
  const text = `期待回信\n这是一段真的前言。\n写给未来慢慢读。\n2026/2/14\n第一篇。\n2026/2/15\n第二篇。`;
  const parsed = splitReadingText(text, '期待回信.txt');
  assert.equal(parsed.chapter_count, 3);
  assert.equal(parsed.chapters[0].title, '写在前面');
  assert.match(parsed.chapters[0].content, /真的前言/);
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
