const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadingToolSafety } = require('../readingToolSafety');

function createQuery(result) {
  const query = {
    select() { return query; },
    eq() { return query; },
    ilike() { return query; },
    order() { return query; },
    limit() { return query; },
    update() { return query; },
    async maybeSingle() { return { data: result, error: null }; },
  };
  return query;
}

function createSupabase({ current = 1 } = {}) {
  return {
    from(table) {
      if (table === 'reading_books') return createQuery({ id: 'book-1', title: '测试书', chapter_count: 8 });
      if (table === 'reading_progress') return createQuery({ chapter_index: current });
      if (table === 'reading_annotations') return createQuery({ id: 'annotation-1', note: '更新后', color: 'blush' });
      return createQuery(null);
    },
  };
}

function createBaseBridge(calls) {
  const names = [
    'read_reading_room',
    'generate_reading_chapter_notes',
    'manage_reading_annotation',
    'manage_reading_book',
  ];
  const tools = names.map(name => ({
    name,
    description: name,
    input_schema: { type: 'object', properties: {}, required: [] },
  }));
  const handlers = new Map([
    ['read_reading_room', async input => { calls.read.push(input); return { ok: true, input }; }],
    ['generate_reading_chapter_notes', async input => {
      calls.notes.push(input);
      return { ok: true, results: [{ chapter_index: input.chapter_index, status: 'ready' }] };
    }],
    ['manage_reading_annotation', async input => { calls.annotation.push(input); return { ok: true }; }],
    ['manage_reading_book', async input => { calls.book.push(input); return { ok: true }; }],
  ]);
  return { tools, handlers };
}

function setup(current = 1) {
  const calls = { read: [], notes: [], annotation: [], book: [] };
  const safe = createReadingToolSafety({
    supabase: createSupabase({ current }),
    bridge: createBaseBridge(calls),
  });
  return { safe, calls };
}

test('读取当前进度之后的章节默认被拦住', async () => {
  const { safe, calls } = setup(1);
  const result = await safe.handlers.get('read_reading_room')({ book_id: 'book-1', chapter_index: 4, include_content: true });
  assert.equal(result.ok, false);
  assert.equal(result.spoiler_blocked, true);
  assert.equal(result.current_chapter_index, 1);
  assert.equal(calls.read.length, 0);
});

test('叶檀明确允许剧透后可以读取后文', async () => {
  const { safe, calls } = setup(1);
  const result = await safe.handlers.get('read_reading_room')({
    book_id: 'book-1',
    chapter_index: 4,
    include_content: true,
    allow_spoilers: true,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.read.length, 1);
});

test('整本预读默认只处理当前进度以内章节', async () => {
  const { safe, calls } = setup(2);
  const result = await safe.handlers.get('generate_reading_chapter_notes')({ book_id: 'book-1' });
  assert.equal(result.processed, 3);
  assert.deepEqual(calls.notes.map(item => item.chapter_index), [0, 1, 2]);
});

test('删除批注和整本书都需要后端确认', async () => {
  const { safe, calls } = setup();
  const annotationResult = await safe.handlers.get('manage_reading_annotation')({ action: 'delete', annotation_id: 'annotation-1' });
  const bookResult = await safe.handlers.get('manage_reading_book')({ action: 'delete', book_id: 'book-1' });
  assert.equal(annotationResult.confirmation_required, true);
  assert.equal(bookResult.confirmation_required, true);
  assert.equal(calls.annotation.length, 0);
  assert.equal(calls.book.length, 0);
});

test('批注颜色统一使用 blush 并由安全桥直接保存', async () => {
  const { safe, calls } = setup();
  const result = await safe.handlers.get('manage_reading_annotation')({
    action: 'update',
    annotation_id: 'annotation-1',
    color: 'rose',
    note: '更新后',
  });
  assert.equal(result.ok, true);
  assert.equal(result.annotation.color, 'blush');
  assert.equal(calls.annotation.length, 0);
});

test('工具 schema 显式暴露防剧透和确认字段', () => {
  const { safe } = setup();
  const read = safe.tools.find(tool => tool.name === 'read_reading_room');
  const notes = safe.tools.find(tool => tool.name === 'generate_reading_chapter_notes');
  const annotation = safe.tools.find(tool => tool.name === 'manage_reading_annotation');
  const book = safe.tools.find(tool => tool.name === 'manage_reading_book');
  assert.ok(read.input_schema.properties.allow_spoilers);
  assert.ok(notes.input_schema.properties.allow_spoilers);
  assert.ok(annotation.input_schema.properties.confirmed);
  assert.ok(book.input_schema.properties.confirmed);
});
