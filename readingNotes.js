const READING_NOTE_COLORS = new Set(['honey', 'blush', 'mint', 'sky', 'lavender']);
const READING_NOTE_KINDS = new Set(['thought', 'quote']);
const READING_NOTE_AUTHORS = new Set(['tan', 'luze']);

function compactLine(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function compactBlock(value, max = 8000) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, max);
}

function clampInt(value, min, max, fallback = min) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeColor(value, fallback = 'sky') {
  const color = String(value || '').trim().toLowerCase();
  if (color === 'rose') return 'blush';
  return READING_NOTE_COLORS.has(color) ? color : fallback;
}

function normalizeKind(value, fallback = 'thought') {
  const kind = String(value || '').trim().toLowerCase();
  return READING_NOTE_KINDS.has(kind) ? kind : fallback;
}

function normalizeAuthor(value, fallback = 'tan') {
  const author = String(value || '').trim().toLowerCase();
  return READING_NOTE_AUTHORS.has(author) ? author : fallback;
}

function createReadingNoteStore(supabase) {
  async function resolveBook({ book_id, title } = {}) {
    const bookId = compactLine(book_id, 80);
    if (bookId) {
      const { data, error } = await supabase.from('reading_books').select('*').eq('id', bookId).maybeSingle();
      if (error) throw error;
      return data || null;
    }

    const keyword = compactLine(title, 160);
    if (keyword) {
      const escaped = keyword.replace(/[\\%_]/g, value => `\\${value}`);
      const { data, error } = await supabase.from('reading_books')
        .select('*')
        .ilike('title', `%${escaped}%`)
        .order('updated_at', { ascending: false })
        .limit(2);
      if (error) throw error;
      return (data || []).length === 1 ? data[0] : null;
    }

    const { data, error } = await supabase.from('reading_books')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(2);
    if (error) throw error;
    return (data || []).length === 1 ? data[0] : null;
  }

  async function resolveChapter(bookId, chapterIndex) {
    if (chapterIndex === undefined || chapterIndex === null || chapterIndex === '') return null;
    const index = clampInt(chapterIndex, 0, 1_000_000, 0);
    const { data, error } = await supabase.from('reading_chapters')
      .select('*')
      .eq('book_id', bookId)
      .eq('chapter_index', index)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function listNotes(bookId, options = {}) {
    const limit = clampInt(options.limit, 1, 200, 40);
    let query = supabase.from('reading_notes')
      .select('*')
      .eq('book_id', bookId)
      .order('pinned', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (options.chapter_index !== undefined && options.chapter_index !== null && options.chapter_index !== '') {
      query = query.eq('chapter_index', clampInt(options.chapter_index, 0, 1_000_000, 0));
    }
    if (options.author && READING_NOTE_AUTHORS.has(String(options.author).toLowerCase())) {
      query = query.eq('author', String(options.author).toLowerCase());
    }
    if (options.kind && READING_NOTE_KINDS.has(String(options.kind).toLowerCase())) {
      query = query.eq('kind', String(options.kind).toLowerCase());
    }
    if (options.pinned_only === true || options.pinned_only === 'true') query = query.eq('pinned', true);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async function createNote(bookId, rawValue = {}, forcedAuthor = null) {
    const { data: book, error: bookError } = await supabase.from('reading_books')
      .select('id, title, chapter_count')
      .eq('id', bookId)
      .maybeSingle();
    if (bookError) throw bookError;
    if (!book) throw new Error('找不到这本书');

    const quote = compactBlock(rawValue.quote, 1200);
    const content = compactBlock(rawValue.content, 8000);
    if (!quote && !content) throw new Error('书签里至少要有摘抄或想法');

    const chapter = await resolveChapter(bookId, rawValue.chapter_index);
    if (rawValue.chapter_index !== undefined && rawValue.chapter_index !== null && !chapter) {
      throw new Error('这本书里没有这个章节');
    }
    if (quote) {
      if (!chapter) throw new Error('保存摘抄时需要指定它所在的章节');
      if (!String(chapter.content || '').includes(quote)) throw new Error('这段摘抄不在指定章节原文里，请重新确认');
    }

    const now = new Date().toISOString();
    const row = {
      book_id: book.id,
      chapter_id: chapter?.id || null,
      chapter_index: chapter?.chapter_index || 0,
      author: normalizeAuthor(forcedAuthor || rawValue.author, forcedAuthor || 'tan'),
      kind: normalizeKind(rawValue.kind, quote ? 'quote' : 'thought'),
      quote,
      content,
      color: normalizeColor(rawValue.color, forcedAuthor === 'luze' ? 'sky' : 'honey'),
      pinned: Boolean(rawValue.pinned),
      updated_at: now,
    };

    const { data, error } = await supabase.from('reading_notes').insert(row).select().single();
    if (error) throw error;
    return data;
  }

  async function updateNote(noteId, rawValue = {}, forcedAuthor = null) {
    const id = compactLine(noteId, 80);
    if (!id) throw new Error('缺少书签编号');
    let query = supabase.from('reading_notes').select('*').eq('id', id);
    if (forcedAuthor) query = query.eq('author', normalizeAuthor(forcedAuthor, 'luze'));
    const { data: existing, error: existingError } = await query.maybeSingle();
    if (existingError) throw existingError;
    if (!existing) throw new Error('找不到这张书签');

    const updates = { updated_at: new Date().toISOString() };
    if (rawValue.content !== undefined) updates.content = compactBlock(rawValue.content, 8000);
    if (rawValue.kind !== undefined) updates.kind = normalizeKind(rawValue.kind, existing.kind);
    if (rawValue.color !== undefined) updates.color = normalizeColor(rawValue.color, existing.color);
    if (rawValue.pinned !== undefined) updates.pinned = Boolean(rawValue.pinned);
    if (rawValue.quote !== undefined) {
      const quote = compactBlock(rawValue.quote, 1200);
      if (quote) {
        const chapter = await resolveChapter(existing.book_id, existing.chapter_index);
        if (!chapter || !String(chapter.content || '').includes(quote)) {
          throw new Error('修改后的摘抄不在原章节里，请重新确认');
        }
      }
      updates.quote = quote;
    }

    const nextQuote = updates.quote === undefined ? existing.quote : updates.quote;
    const nextContent = updates.content === undefined ? existing.content : updates.content;
    if (!String(nextQuote || '').trim() && !String(nextContent || '').trim()) {
      throw new Error('书签里至少要保留摘抄或想法');
    }

    let updateQuery = supabase.from('reading_notes').update(updates).eq('id', id);
    if (forcedAuthor) updateQuery = updateQuery.eq('author', normalizeAuthor(forcedAuthor, 'luze'));
    const { data, error } = await updateQuery.select().maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('找不到这张书签');
    return data;
  }

  async function deleteNote(noteId, forcedAuthor = null) {
    const id = compactLine(noteId, 80);
    if (!id) throw new Error('缺少书签编号');
    let query = supabase.from('reading_notes').delete().eq('id', id);
    if (forcedAuthor) query = query.eq('author', normalizeAuthor(forcedAuthor, 'luze'));
    const { data, error } = await query.select('id').maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }

  return {
    resolveBook,
    listNotes,
    createNote,
    updateNote,
    deleteNote,
  };
}

const READING_NOTE_TOOLS = Object.freeze([
  {
    name: 'read_reading_notes',
    description: '读取共读小屋里叶檀或陆泽留下的独立书签、摘抄和感想。它们不是原文，也不是批注回复。需要知道最近摘抄、置顶感想或陆泽自己留下了什么时先读取。',
    input_schema: {
      type: 'object',
      properties: {
        book_id: { type: 'string', description: '书籍编号；不知道时可先读取书架' },
        title: { type: 'string', description: '没有编号时用书名关键词定位' },
        chapter_index: { type: 'integer', minimum: 0 },
        author: { type: 'string', enum: ['tan', 'luze'] },
        kind: { type: 'string', enum: ['thought', 'quote'] },
        pinned_only: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: [],
    },
  },
  {
    name: 'write_reading_note',
    description: '让陆泽在共读小屋里留下、修改、置顶或删除一张独立书签/摘抄。不会修改书籍原文。创建摘抄时 quote 必须真实存在于指定章节。删除只有叶檀明确要求且目标准确时才能把 confirmed 设为 true。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'pin', 'delete'] },
        note_id: { type: 'string', description: '修改、置顶或删除时需要' },
        book_id: { type: 'string', description: '创建时需要；不知道时先读取书架' },
        title: { type: 'string', description: '创建时可用书名定位' },
        chapter_index: { type: 'integer', minimum: 0 },
        kind: { type: 'string', enum: ['thought', 'quote'] },
        quote: { type: 'string', maxLength: 1200 },
        content: { type: 'string', maxLength: 8000 },
        color: { type: 'string', enum: ['honey', 'blush', 'mint', 'sky', 'lavender'] },
        pinned: { type: 'boolean' },
        confirmed: { type: 'boolean', description: '仅删除时使用；必须在叶檀明确确认后才能设为 true' },
      },
      required: ['action'],
    },
  },
]);

function createReadingNoteAssistant({ supabase }) {
  const store = createReadingNoteStore(supabase);

  async function readNotes(input = {}) {
    const book = await store.resolveBook(input);
    if (!book) {
      return { ok: false, error: '没有唯一找到这本书，请先读取书架并使用 book_id。' };
    }
    return {
      ok: true,
      book: { id: book.id, title: book.title },
      notes: await store.listNotes(book.id, input),
    };
  }

  async function writeNote(input = {}) {
    const action = String(input.action || '').trim();
    if (action === 'create') {
      const book = await store.resolveBook(input);
      if (!book) return { ok: false, error: '没有唯一找到这本书，请先读取书架并使用 book_id。' };
      return { ok: true, note: await store.createNote(book.id, input, 'luze') };
    }
    if (!input.note_id) return { ok: false, error: '这个操作需要准确的书签编号' };
    if (action === 'delete') {
      if (input.confirmed !== true) {
        return { ok: false, confirmation_required: true, error: '删除书签需要叶檀明确确认。确认后再把 confirmed 设为 true。' };
      }
      const deleted = await store.deleteNote(input.note_id, 'luze');
      return deleted
        ? { ok: true, note_id: input.note_id, deleted: true }
        : { ok: false, error: '找不到这张陆泽书签' };
    }
    if (action === 'pin') {
      return { ok: true, note: await store.updateNote(input.note_id, { pinned: input.pinned !== false }, 'luze') };
    }
    if (action === 'update') {
      return { ok: true, note: await store.updateNote(input.note_id, input, 'luze') };
    }
    return { ok: false, error: '未知的书签操作' };
  }

  function getToolBridge() {
    const handlers = new Map([
      ['read_reading_notes', readNotes],
      ['write_reading_note', writeNote],
    ]);
    return { tools: [...READING_NOTE_TOOLS], handlers };
  }

  return { store, readNotes, writeNote, getToolBridge };
}

function registerReadingNoteRoutes(app, { supabase }) {
  const store = createReadingNoteStore(supabase);

  app.get('/reading/books/:bookId/notes', async (req, res) => {
    try {
      res.json(await store.listNotes(req.params.bookId, {
        chapter_index: req.query.chapter_index,
        author: req.query.author,
        kind: req.query.kind,
        pinned_only: req.query.pinned_only,
        limit: req.query.limit,
      }));
    } catch (error) {
      res.status(500).json({ error: error.message || '共读书签暂时没有打开' });
    }
  });

  app.post('/reading/books/:bookId/notes', async (req, res) => {
    try {
      res.json(await store.createNote(req.params.bookId, req.body || {}, 'tan'));
    } catch (error) {
      res.status(400).json({ error: error.message || '书签没有保存成功' });
    }
  });

  app.patch('/reading/notes/:id', async (req, res) => {
    try {
      res.json(await store.updateNote(req.params.id, req.body || {}));
    } catch (error) {
      res.status(400).json({ error: error.message || '书签没有保存成功' });
    }
  });

  app.delete('/reading/notes/:id', async (req, res) => {
    try {
      const deleted = await store.deleteNote(req.params.id);
      if (!deleted) return res.status(404).json({ error: '找不到这张书签' });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message || '书签没有删除成功' });
    }
  });

  return store;
}

module.exports = {
  READING_NOTE_COLORS,
  READING_NOTE_KINDS,
  READING_NOTE_TOOLS,
  normalizeColor,
  createReadingNoteStore,
  createReadingNoteAssistant,
  registerReadingNoteRoutes,
};