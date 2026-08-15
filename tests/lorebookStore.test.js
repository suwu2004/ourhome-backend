const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseLorebookImport,
  parseOptionalBoolean,
  entryMatches,
  selectLorebookEntries,
  compileLorebookContext,
  safeRegex,
  exportLorebookV3,
} = require('../lorebookStore');

test('imports Character Card lorebook fields and preserves unknown extensions', () => {
  const parsed = parseLorebookImport(JSON.stringify({
    spec: 'chara_card_v3',
    data: {
      name: '陆宅设定',
      character_book: {
        name: '陆宅世界书',
        scan_depth: 18,
        token_budget: 3200,
        mystery: 'preserve me',
        entries: [{
          keys: ['老宅'],
          secondary_keys: ['雨夜'],
          selective: true,
          content: '老宅在城南。',
          enabled: true,
          insertion_order: 12,
          custom_field: 7,
        }],
      },
    },
  }), 'card.json');

  assert.equal(parsed.book.name, '陆宅世界书');
  assert.equal(parsed.book.scan_depth, 18);
  assert.equal(parsed.book.token_budget, 3200);
  assert.equal(parsed.book.raw_metadata.imported_unknown.mystery, 'preserve me');
  assert.deepEqual(parsed.entries[0].keys, ['老宅']);
  assert.equal(parsed.entries[0].extensions.imported_unknown.custom_field, 7);
});

test('plain text becomes one constant entry without losing the source', () => {
  const parsed = parseLorebookImport('一整份完整世界设定。', '完整世界.md');
  assert.equal(parsed.book.name, '完整世界');
  assert.equal(parsed.book.source_format, 'plain_text');
  assert.equal(parsed.entries[0].constant, true);
  assert.equal(parsed.entries[0].content, '一整份完整世界设定。');
});

test('optional multipart booleans keep old defaults and accept an explicit disabled import', () => {
  assert.equal(parseOptionalBoolean(undefined, true), true);
  assert.equal(parseOptionalBoolean('', false), false);
  assert.equal(parseOptionalBoolean('true', false), true);
  assert.equal(parseOptionalBoolean('false', true), false);
  assert.equal(parseOptionalBoolean('0', true), false);
});

test('imports Risu array-shaped lorebooks', () => {
  const parsed = parseLorebookImport({
    type: 'risu',
    name: 'Risu 世界',
    data: [{ key: ['钟楼'], content: '钟楼每天午夜响十三次。', alwaysActive: false }],
  }, 'risu.json');
  assert.equal(parsed.book.source_format, 'risu');
  assert.equal(parsed.entries.length, 1);
  assert.deepEqual(parsed.entries[0].keys, ['钟楼']);
});

test('selective entries need both primary and secondary activation', () => {
  const entry = {
    enabled: true,
    keys: ['老宅'],
    secondary_keys: ['雨夜'],
    selective: true,
    constant: false,
    use_regex: false,
  };
  assert.equal(entryMatches(entry, '我们回到了老宅。'), false);
  assert.equal(entryMatches(entry, '雨夜里，我们回到了老宅。'), true);
});

test('recursive scan can wake a second entry from the first entry content', () => {
  const book = { scan_depth: 8, token_budget: 2000, recursive_scanning: true };
  const entries = [
    { id: '1', name: '入口', content: '暗门通向月塔。', keys: ['暗门'], enabled: true, priority: 2, insertion_order: 1 },
    { id: '2', name: '月塔', content: '月塔顶层藏着银钥匙。', keys: ['月塔'], enabled: true, priority: 1, insertion_order: 2 },
  ];
  assert.deepEqual(selectLorebookEntries(book, entries, ['她推开了暗门。']).map(item => item.id), ['1', '2']);
});

test('scope and theater binding keep Chat and small worlds isolated', () => {
  const books = [
    { id: 'global', name: '共用', enabled: true, apply_scope: 'both', scan_depth: 8, token_budget: 500 },
    { id: 'bound', name: '甲剧场', enabled: true, apply_scope: 'theater', target_book_id: 'book-a', scan_depth: 8, token_budget: 500 },
  ];
  const entries = [
    { id: 'g', lorebook_id: 'global', name: '常识', content: '共用内容', constant: true, enabled: true },
    { id: 'b', lorebook_id: 'bound', name: '私有', content: '甲剧场内容', constant: true, enabled: true },
  ];
  const chat = compileLorebookContext(books, entries, ['你好'], { scope: 'chat' });
  const theaterA = compileLorebookContext(books, entries, ['你好'], { scope: 'theater', targetBookId: 'book-a' });
  const theaterB = compileLorebookContext(books, entries, ['你好'], { scope: 'theater', targetBookId: 'book-b' });
  assert.match(chat, /共用内容/);
  assert.doesNotMatch(chat, /甲剧场内容/);
  assert.match(theaterA, /甲剧场内容/);
  assert.doesNotMatch(theaterB, /甲剧场内容/);
});

test('regex guard rejects backreferences and nested quantifier shapes', () => {
  assert.ok(safeRegex('陆(泽|先生)'));
  assert.equal(safeRegex('(a+)+$'), null);
  assert.equal(safeRegex('(a)\\1'), null);
});

test('exports a standalone lorebook v3 document', () => {
  const exported = exportLorebookV3({
    name: '测试世界',
    description: '',
    scan_depth: 12,
    token_budget: 1000,
    recursive_scanning: false,
    entries: [{ name: '地点', keys: ['花园'], content: '花园在东侧。', enabled: true }],
  });
  assert.equal(exported.spec, 'lorebook_v3');
  assert.equal(exported.data.entries[0].name, '地点');
  assert.deepEqual(exported.data.entries[0].keys, ['花园']);
});
