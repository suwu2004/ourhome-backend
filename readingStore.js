const { registerReadingAnnotationRoutes } = require('./readingAnnotations');
const { registerTheaterRuleRoutes } = require('./theaterRuleStore');
const DATE_HEADING_RE = /^\s*(20\d{2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*(?:日)?(?:\s*[/／-]?\s*.*)?$/;
const CHAPTER_HEADING_RE = /^\s*(?:第[零〇一二三四五六七八九十百千万\d]+[章节卷部篇回](?:(?:\s+|[：:、.．-]\s*).{1,36})?|卷[零〇一二三四五六七八九十百千万\d]+(?:(?:\s+|[：:、.．-]\s*).{1,36})?|\d{1,4}\s*[.．、]\s*(?![^\n]*[：:])\S.{0,34})\s*$/;
const MAX_READING_CHAPTERS = 2000;
const MAX_READING_CHARS = 4_000_000;

function normalizeReadingText(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function cleanBookTitle(value, fallback = '未命名书籍') {
  const title = String(value || '')
    .replace(/\.(?:txt|md)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return title.slice(0, 120) || fallback;
}

function detectBookTitle(text, sourceName) {
  const fallback = cleanBookTitle(sourceName);
  const firstLine = text.split('\n').map(line => line.trim()).find(Boolean) || '';
  if (firstLine && firstLine.length <= 80 && !DATE_HEADING_RE.test(firstLine) && !CHAPTER_HEADING_RE.test(firstLine)) {
    return firstLine;
  }
  return fallback;
}

function normalizeTitleKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[《》〈〉「」『』【】()（）\[\]{}\s·•:：,，。.!！?？_\-—]+/g, '')
    .toLowerCase();
}

function isRedundantTitlePreface(preface, fallbackTitle) {
  const lines = String(preface || '').split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) return false;
  const prefaceKey = normalizeTitleKey(lines[0]);
  const titleKey = normalizeTitleKey(fallbackTitle);
  return Boolean(prefaceKey && titleKey && prefaceKey === titleKey);
}

function headingIndexes(lines, pattern) {
  const indexes = [];
  lines.forEach((line, index) => {
    const title = line.trim();
    if (!title || title.length > 90) return;
    if (pattern.test(title)) indexes.push(index);
  });
  return indexes;
}

function chaptersFromIndexes(lines, indexes, fallbackTitle) {
  if (!indexes.length) {
    const content = lines.join('\n').trim();
    return [{ chapter_index: 0, title: fallbackTitle, content, char_count: content.length }];
  }

  const chapters = [];
  if (indexes[0] > 0) {
    const preface = lines.slice(0, indexes[0]).join('\n').trim();
    if (preface && !isRedundantTitlePreface(preface, fallbackTitle)) {
      chapters.push({ title: '写在前面', content: preface });
    }
  }

  indexes.forEach((start, position) => {
    const end = indexes[position + 1] ?? lines.length;
    const content = lines.slice(start, end).join('\n').trim();
    if (!content) return;
    chapters.push({
      title: lines[start].trim().slice(0, 120) || `第 ${position + 1} 篇`,
      content,
    });
  });

  return chapters.slice(0, MAX_READING_CHAPTERS).map((chapter, chapterIndex) => ({
    chapter_index: chapterIndex,
    title: chapter.title,
    content: chapter.content,
    char_count: chapter.content.length,
  }));
}

function splitReadingText(rawText, sourceName = '未命名书籍.txt') {
  const text = normalizeReadingText(rawText);
  if (!text) throw new Error('这个文件里没有读到文字。');
  if (text.length > MAX_READING_CHARS) throw new Error('这本书太大了，先拆成几本再导入会更稳。');

  const lines = text.split('\n');
  const title = detectBookTitle(text, sourceName);
  const dateIndexes = headingIndexes(lines, DATE_HEADING_RE);
  const chapterIndexes = headingIndexes(lines, CHAPTER_HEADING_RE);
  const mode = dateIndexes.length >= 2 ? 'date' : chapterIndexes.length >= 2 ? 'chapter' : 'single';
  const indexes = mode === 'date' ? dateIndexes : mode === 'chapter' ? chapterIndexes : [];
  const chapters = chaptersFromIndexes(lines, indexes, title);

  return {
    title,
    source_name: String(sourceName || '').slice(0, 240) || `${title}.txt`,
    source_kind: 'txt',
    split_mode: mode,
    total_chars: text.length,
    chapter_count: chapters.length,
    chapters,
  };
}

function countReplacementCharacters(value) {
  return (String(value || '').match(/�/g) || []).length;
}

function decodeReadingFile(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('没有收到可读取的文件。');
  const utf8 = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const utf8Bad = countReplacementCharacters(utf8);
  if (!utf8Bad || utf8Bad / Math.max(utf8.length, 1) < 0.002) return utf8;

  try {
    const gb18030 = new TextDecoder('gb18030', { fatal: false }).decode(buffer);
    if (countReplacementCharacters(gb18030) < utf8Bad) return gb18030;
  } catch {
    // 当前 Node 构建不支持该编码时继续使用 UTF-8 结果，由页面提示用户另存为 UTF-8。
  }
  return utf8;
}

function normalizeProgress(value = {}) {
  const chapterIndex = Math.max(0, Math.round(Number(value.chapter_index) || 0));
  const paragraphIndex = Math.max(0, Math.round(Number(value.paragraph_index) || 0));
  const charOffset = Math.max(0, Math.round(Number(value.char_offset) || 0));
  const percentage = Number(value.progress_percent);
  return {
    chapter_index: chapterIndex,
    paragraph_index: paragraphIndex,
    char_offset: charOffset,
    progress_percent: Number.isFinite(percentage) ? Math.max(0, Math.min(100, Number(percentage.toFixed(2)))) : 0,
    updated_at: new Date().toISOString(),
  };
}

function createReadingStore(supabase) {
  async function listBooks() {
    const { data, error } = await supabase
      .from('reading_books')
      .select('id, title, source_name, source_kind, split_mode, total_chars, chapter_count, created_at, updated_at, reading_progress(chapter_index, paragraph_index, char_offset, progress_percent, updated_at)')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(book => ({
      ...book,
      progress: Array.isArray(book.reading_progress) ? (book.reading_progress[0] || null) : (book.reading_progress || null),
      reading_progress: undefined,
    }));
  }

  async function getBook(bookId) {
    const [{ data: book, error: bookError }, { data: chapters, error: chaptersError }, { data: progress, error: progressError }] = await Promise.all([
      supabase.from('reading_books').select('*').eq('id', bookId).maybeSingle(),
      supabase.from('reading_chapters').select('id, book_id, chapter_index, title, content, char_count, created_at').eq('book_id', bookId).order('chapter_index', { ascending: true }),
      supabase.from('reading_progress').select('*').eq('book_id', bookId).maybeSingle(),
    ]);
    const error = bookError || chaptersError || progressError;
    if (error) throw error;
    if (!book) return null;
    return { ...book, chapters: chapters || [], progress: progress || normalizeProgress() };
  }

  async function importBook(file) {
    const name = String(file?.originalname || '未命名书籍.txt');
    const lowerName = name.toLowerCase();
    const mime = String(file?.mimetype || '').toLowerCase();
    if (!lowerName.endsWith('.txt') && !lowerName.endsWith('.md') && !mime.startsWith('text/')) {
      throw new Error('第一阶段先支持 TXT 或 Markdown 文本。');
    }
    const parsed = splitReadingText(decodeReadingFile(file.buffer), name);
    const { data: book, error: bookError } = await supabase.from('reading_books').insert({
      title: parsed.title,
      source_name: parsed.source_name,
      source_kind: parsed.source_kind,
      split_mode: parsed.split_mode,
      total_chars: parsed.total_chars,
      chapter_count: parsed.chapter_count,
    }).select().single();
    if (bookError) throw bookError;

    try {
      const rows = parsed.chapters.map(chapter => ({ ...chapter, book_id: book.id }));
      for (let start = 0; start < rows.length; start += 100) {
        const { error } = await supabase.from('reading_chapters').insert(rows.slice(start, start + 100));
        if (error) throw error;
      }
      const progress = normalizeProgress();
      const { error: progressError } = await supabase.from('reading_progress').insert({ book_id: book.id, ...progress });
      if (progressError) throw progressError;
      return await getBook(book.id);
    } catch (error) {
      await supabase.from('reading_books').delete().eq('id', book.id);
      throw error;
    }
  }

  async function saveProgress(bookId, value) {
    const progress = normalizeProgress(value);
    const { data, error } = await supabase.from('reading_progress')
      .upsert({ book_id: bookId, ...progress }, { onConflict: 'book_id' })
      .select()
      .single();
    if (error) throw error;
    await supabase.from('reading_books').update({ updated_at: progress.updated_at }).eq('id', bookId);
    return data;
  }

  async function renameBook(bookId, title) {
    const safeTitle = cleanBookTitle(title);
    const { data, error } = await supabase.from('reading_books')
      .update({ title: safeTitle, updated_at: new Date().toISOString() })
      .eq('id', bookId)
      .select()
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function deleteBook(bookId) {
    const { data, error } = await supabase.from('reading_books').delete().eq('id', bookId).select('id').maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }

  return { listBooks, getBook, importBook, saveProgress, renameBook, deleteBook };
}

function registerReadingRoutes(app, { supabase, upload }) {
  const store = createReadingStore(supabase);
  registerReadingAnnotationRoutes(app, { supabase });
  registerTheaterRuleRoutes(app, { supabase });

  app.get('/reading/books', async (_req, res) => {
    try { res.json(await store.listBooks()); }
    catch (error) { res.status(500).json({ error: error.message || '书架暂时没有打开' }); }
  });

  app.post('/reading/books/import', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: '先选择一本 TXT。' });
      res.json(await store.importBook(req.file));
    } catch (error) {
      res.status(400).json({ error: error.message || '这本书没有导入成功' });
    }
  });

  app.get('/reading/books/:id', async (req, res) => {
    try {
      const book = await store.getBook(req.params.id);
      if (!book) return res.status(404).json({ error: '找不到这本书' });
      res.json(book);
    } catch (error) {
      res.status(500).json({ error: error.message || '这本书暂时没有打开' });
    }
  });

  app.put('/reading/books/:id/progress', async (req, res) => {
    try { res.json(await store.saveProgress(req.params.id, req.body || {})); }
    catch (error) { res.status(400).json({ error: error.message || '阅读位置没有保存成功' }); }
  });

  app.patch('/reading/books/:id', async (req, res) => {
    try {
      if (!String(req.body?.title || '').trim()) return res.status(400).json({ error: '书名不能为空' });
      const book = await store.renameBook(req.params.id, req.body.title);
      if (!book) return res.status(404).json({ error: '找不到这本书' });
      res.json(book);
    } catch (error) {
      res.status(400).json({ error: error.message || '书名没有保存成功' });
    }
  });

  app.delete('/reading/books/:id', async (req, res) => {
    try {
      const deleted = await store.deleteBook(req.params.id);
      if (!deleted) return res.status(404).json({ error: '找不到这本书' });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message || '这本书没有删除成功' });
    }
  });

  return store;
}

module.exports = {
  DATE_HEADING_RE,
  CHAPTER_HEADING_RE,
  normalizeReadingText,
  decodeReadingFile,
  splitReadingText,
  normalizeProgress,
  createReadingStore,
  registerReadingRoutes,
};
