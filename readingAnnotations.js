const { createReadingAssistant } = require('./readingAssistant');
const { registerReadingNoteRoutes } = require('./readingNotes');

const MAX_QUOTE_CHARS = 1200;
const MAX_NOTE_CHARS = 4000;
const MAX_CONTEXT_CHARS = 500;
const ANNOTATION_COLORS = new Set(['honey', 'blush', 'mint', 'sky', 'lavender']);

function cleanText(value, max) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function normalizeColor(value) {
  const color = String(value || '').trim().toLowerCase();
  if (color === 'rose') return 'blush';
  return ANNOTATION_COLORS.has(color) ? color : 'honey';
}

function splitReadingParagraphs(content) {
  return String(content || '')
    .split(/\n{2,}|\n/)
    .map(item => item.trim())
    .filter(Boolean);
}

function normalizeAnnotationInput(value = {}) {
  const paragraphIndex = Math.max(0, Math.round(Number(value.paragraph_index) || 0));
  const startOffset = Math.max(0, Math.round(Number(value.start_offset) || 0));
  const endOffset = Math.max(startOffset + 1, Math.round(Number(value.end_offset) || 0));
  return {
    chapter_id: cleanText(value.chapter_id, 80),
    chapter_index: Math.max(0, Math.round(Number(value.chapter_index) || 0)),
    paragraph_index: paragraphIndex,
    start_offset: startOffset,
    end_offset: endOffset,
    quote: cleanText(value.quote, MAX_QUOTE_CHARS),
    prefix: cleanText(value.prefix, MAX_CONTEXT_CHARS),
    suffix: cleanText(value.suffix, MAX_CONTEXT_CHARS),
    note: cleanText(value.note, MAX_NOTE_CHARS),
    color: normalizeColor(value.color),
  };
}

function createReadingAnnotationStore(supabase) {
  async function listAnnotations(bookId, chapterId = '') {
    let query = supabase
      .from('reading_annotations')
      .select('*')
      .eq('book_id', bookId)
      .order('chapter_index', { ascending: true })
      .order('paragraph_index', { ascending: true })
      .order('start_offset', { ascending: true });
    if (chapterId) query = query.eq('chapter_id', chapterId);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async function createAnnotation(bookId, rawValue) {
    const value = normalizeAnnotationInput(rawValue);
    if (!value.chapter_id) throw new Error('没有找到这段文字所在的篇章。');

    const { data: chapter, error: chapterError } = await supabase
      .from('reading_chapters')
      .select('id, book_id, chapter_index, content')
      .eq('id', value.chapter_id)
      .eq('book_id', bookId)
      .maybeSingle();
    if (chapterError) throw chapterError;
    if (!chapter) throw new Error('这段文字已经不在当前书里了。');

    const paragraphs = splitReadingParagraphs(chapter.content);
    const paragraph = paragraphs[value.paragraph_index];
    if (!paragraph) throw new Error('没有找到选中的这一段，请重新划一下。');
    if (value.end_offset > paragraph.length) throw new Error('选中的文字位置已经变化，请重新划一下。');

    const authoritativeQuote = paragraph.slice(value.start_offset, value.end_offset);
    if (!authoritativeQuote.trim()) throw new Error('先选中一小段文字。');
    if (authoritativeQuote.length > MAX_QUOTE_CHARS) throw new Error('一次划线不要超过 1200 字。');

    const { data: overlaps, error: overlapError } = await supabase
      .from('reading_annotations')
      .select('id')
      .eq('chapter_id', chapter.id)
      .eq('paragraph_index', value.paragraph_index)
      .lt('start_offset', value.end_offset)
      .gt('end_offset', value.start_offset)
      .limit(1);
    if (overlapError) throw overlapError;
    if (overlaps?.length) throw new Error('这段文字已经有划线了，可以点原来的划线继续写。');

    const now = new Date().toISOString();
    const row = {
      book_id: bookId,
      chapter_id: chapter.id,
      chapter_index: chapter.chapter_index,
      paragraph_index: value.paragraph_index,
      start_offset: value.start_offset,
      end_offset: value.end_offset,
      quote: authoritativeQuote,
      prefix: paragraph.slice(Math.max(0, value.start_offset - 180), value.start_offset),
      suffix: paragraph.slice(value.end_offset, value.end_offset + 180),
      note: value.note,
      color: value.color,
      updated_at: now,
    };
    const { data, error } = await supabase.from('reading_annotations').insert(row).select().single();
    if (error) throw error;
    return data;
  }

  async function updateAnnotation(annotationId, rawValue) {
    const patch = {
      note: cleanText(rawValue?.note, MAX_NOTE_CHARS),
      updated_at: new Date().toISOString(),
    };
    if (rawValue?.color !== undefined) patch.color = normalizeColor(rawValue.color);
    const { data, error } = await supabase
      .from('reading_annotations')
      .update(patch)
      .eq('id', annotationId)
      .select()
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function deleteAnnotation(annotationId) {
    const { data, error } = await supabase
      .from('reading_annotations')
      .delete()
      .eq('id', annotationId)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }

  return { listAnnotations, createAnnotation, updateAnnotation, deleteAnnotation };
}

function registerReadingAnnotationRoutes(app, { supabase }) {
  const store = createReadingAnnotationStore(supabase);
  const assistant = createReadingAssistant({ supabase });
  registerReadingNoteRoutes(app, { supabase });

  app.get('/reading/books/:bookId/annotations', async (req, res) => {
    try {
      res.json(await store.listAnnotations(req.params.bookId, String(req.query.chapter_id || '')));
    } catch (error) {
      res.status(500).json({ error: error.message || '划线暂时没有打开' });
    }
  });

  app.post('/reading/books/:bookId/annotations', async (req, res) => {
    try {
      res.json(await store.createAnnotation(req.params.bookId, req.body || {}));
    } catch (error) {
      res.status(400).json({ error: error.message || '这条划线没有保存成功' });
    }
  });

  app.patch('/reading/annotations/:id', async (req, res) => {
    try {
      const annotation = await store.updateAnnotation(req.params.id, req.body || {});
      if (!annotation) return res.status(404).json({ error: '找不到这条划线' });
      res.json(annotation);
    } catch (error) {
      res.status(400).json({ error: error.message || '批注没有保存成功' });
    }
  });

  app.delete('/reading/annotations/:id', async (req, res) => {
    try {
      const deleted = await store.deleteAnnotation(req.params.id);
      if (!deleted) return res.status(404).json({ error: '找不到这条划线' });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message || '划线没有删除成功' });
    }
  });

  app.post('/reading/annotations/:id/luze-reply', async (req, res) => {
    try {
      const annotation = await assistant.generateAnnotationReply(req.params.id, {
        instruction: req.body?.instruction,
        model: req.body?.model,
        source: 'reading_room_button',
      });
      res.json(annotation);
    } catch (error) {
      res.status(500).json({ error: error.message || '陆泽这次没有接上批注' });
    }
  });

  app.put('/reading/annotations/:id/luze-reply', async (req, res) => {
    try {
      const result = await assistant.replyReadingAnnotation({
        annotation_id: req.params.id,
        reply: req.body?.reply,
        model: req.body?.model || '陆泽·手写回复',
      });
      if (!result.ok) return res.status(400).json({ error: result.error });
      res.json(result.annotation);
    } catch (error) {
      res.status(500).json({ error: error.message || '陆泽的回复没有保存成功' });
    }
  });

  app.delete('/reading/annotations/:id/luze-reply', async (req, res) => {
    try {
      const result = await assistant.manageReadingAnnotation({
        action: 'clear_luze_reply',
        annotation_id: req.params.id,
      });
      if (!result.ok) return res.status(404).json({ error: result.error });
      res.json(result.annotation);
    } catch (error) {
      res.status(500).json({ error: error.message || '陆泽的旧回复没有清除成功' });
    }
  });

  app.get('/reading/books/:bookId/chapter-notes', async (req, res) => {
    try {
      const result = await assistant.readWorkbench({ book_id: req.params.bookId, limit: req.query.limit || 100 });
      res.json(result.chapter_notes);
    } catch (error) {
      res.status(500).json({ error: error.message || '章节预读笔记暂时没有打开' });
    }
  });

  app.post('/reading/books/:bookId/chapter-notes/generate', async (req, res) => {
    try {
      res.json(await assistant.generateBookNotes(req.params.bookId, {
        chapterIndex: req.body?.chapter_index,
        force: Boolean(req.body?.force),
      }));
    } catch (error) {
      res.status(500).json({ error: error.message || '章节预读笔记没有生成成功' });
    }
  });

  app.get('/reading/workbench', async (req, res) => {
    try {
      res.json(await assistant.readWorkbench({
        book_id: req.query.book_id,
        limit: req.query.limit || 60,
      }));
    } catch (error) {
      res.status(500).json({ error: error.message || '共读工作台暂时没有打开' });
    }
  });

  return { ...store, assistant };
}

module.exports = {
  MAX_QUOTE_CHARS,
  MAX_NOTE_CHARS,
  ANNOTATION_COLORS,
  splitReadingParagraphs,
  normalizeAnnotationInput,
  createReadingAnnotationStore,
  registerReadingAnnotationRoutes,
};