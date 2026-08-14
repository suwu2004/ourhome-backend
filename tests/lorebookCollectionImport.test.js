'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseLorebookCollection,
  parseKeywordLine,
} = require('../lorebookCollectionImport');

test('collection importer splits catalog-backed document into separate books', () => {
  const raw = `世界书合集\n1.《常驻甲》\n2.《场景乙》\n3.《常驻丙》\n世界书功能总览\n《常驻甲》\n说明甲\n《场景乙》\n说明乙\n《常驻丙》\n说明丙\n后面是世界书正文部分\n除了《场景乙2.0》，其他都是常驻世界书。\n常驻甲\n甲正文\n场景乙\n请设置关键词：进入乙,开启乙\n乙正文\n常驻丙（通用）\n丙正文`;
  const books = parseLorebookCollection(raw, '合集.docx');
  assert.equal(books.length, 3);
  assert.deepEqual(books.map(book => book.name), ['常驻甲', '场景乙', '常驻丙']);
  assert.equal(books[0].entry.constant, true);
  assert.equal(books[1].entry.constant, false);
  assert.deepEqual(books[1].entry.keys, ['进入乙', '开启乙']);
  assert.equal(books[2].entry.constant, true);
  assert.match(books[2].entry.content, /丙正文/);
});

test('collection importer ignores ordinary single worldbook documents', () => {
  assert.equal(parseLorebookCollection('单独一本世界书\n正文', 'single.docx'), null);
});

test('keyword parser accepts Chinese and English labels', () => {
  assert.deepEqual(parseKeywordLine('请设置关键词：过去线, 回到过去'), ['过去线', '回到过去']);
  assert.deepEqual(parseKeywordLine('Keywords: foo,bar'), ['foo', 'bar']);
  assert.deepEqual(parseKeywordLine('Keywords：无（常驻激活）'), []);
});
