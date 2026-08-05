const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  splitReadingParagraphs,
  normalizeAnnotationInput,
} = require('../readingAnnotations');

test('正文拆段方式与阅读器一致', () => {
  assert.deepEqual(
    splitReadingParagraphs('第一段。\n\n第二段。\n第三段。'),
    ['第一段。', '第二段。', '第三段。'],
  );
});

test('划线位置与文本输入会被安全规范化', () => {
  const value = normalizeAnnotationInput({
    chapter_id: ' chapter-1 ',
    chapter_index: 2.4,
    paragraph_index: 3.7,
    start_offset: 8.2,
    end_offset: 3,
    quote: '  一段想留下的话  ',
    note: '  我的想法  ',
    color: 'blush',
  });
  assert.equal(value.chapter_id, 'chapter-1');
  assert.equal(value.chapter_index, 2);
  assert.equal(value.paragraph_index, 4);
  assert.equal(value.start_offset, 8);
  assert.equal(value.end_offset, 9);
  assert.equal(value.quote, '一段想留下的话');
  assert.equal(value.note, '我的想法');
  assert.equal(value.color, 'blush');
});

test('共读路由会注册划线与批注模块', () => {
  const readingStore = fs.readFileSync(path.join(__dirname, '..', 'readingStore.js'), 'utf8');
  assert.match(readingStore, /registerReadingAnnotationRoutes/);
  assert.match(readingStore, /registerReadingAnnotationRoutes\(app, \{ supabase \}\)/);
});
