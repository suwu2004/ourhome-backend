function compactLine(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clampInt(value, min, max, fallback = min) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function cloneTool(tool) {
  return {
    ...tool,
    input_schema: {
      ...(tool.input_schema || { type: 'object' }),
      properties: { ...(tool.input_schema?.properties || {}) },
      required: [...(tool.input_schema?.required || [])],
    },
  };
}

function createReadingToolSafety({ supabase, bridge }) {
  if (!supabase) throw new Error('reading tool safety requires supabase');
  if (!bridge || !(bridge.handlers instanceof Map)) throw new Error('reading tool safety requires a tool bridge');

  const tools = (bridge.tools || []).map(cloneTool);
  const handlers = new Map(bridge.handlers);

  async function resolveBook(input = {}) {
    const bookId = compactLine(input.book_id, 80);
    if (bookId) {
      const { data, error } = await supabase.from('reading_books').select('id, title, chapter_count').eq('id', bookId).maybeSingle();
      if (error) throw error;
      return data || null;
    }

    const title = compactLine(input.title, 160);
    if (title) {
      const escaped = title.replace(/[\\%_]/g, value => `\\${value}`);
      const { data, error } = await supabase.from('reading_books')
        .select('id, title, chapter_count')
        .ilike('title', `%${escaped}%`)
        .order('updated_at', { ascending: false })
        .limit(2);
      if (error) throw error;
      return (data || []).length === 1 ? data[0] : null;
    }
    return null;
  }

  async function currentChapterIndex(bookId) {
    const { data, error } = await supabase.from('reading_progress')
      .select('chapter_index')
      .eq('book_id', bookId)
      .maybeSingle();
    if (error) throw error;
    return Math.max(0, Number(data?.chapter_index) || 0);
  }

  async function checkSpoilerBoundary(input = {}) {
    if (input.allow_spoilers === true) return { allowed: true };
    if (input.chapter_index === undefined || input.chapter_index === null) return { allowed: true };
    const book = await resolveBook(input);
    if (!book) return { allowed: true };
    const current = await currentChapterIndex(book.id);
    const requested = clampInt(input.chapter_index, 0, Math.max(0, Number(book.chapter_count || 1) - 1), 0);
    if (requested <= current) return { allowed: true, book, current, requested };
    return {
      allowed: false,
      book,
      current,
      requested,
      result: {
        ok: false,
        spoiler_blocked: true,
        current_chapter_index: current,
        requested_chapter_index: requested,
        error: `叶檀目前读到第 ${current + 1} 篇，读取第 ${requested + 1} 篇会越过当前进度。只有她明确要求提前看或允许剧透时，才能把 allow_spoilers 设为 true。`,
      },
    };
  }

  const readTool = tools.find(tool => tool.name === 'read_reading_room');
  if (readTool) {
    readTool.description = `${readTool.description} 默认不得读取当前阅读进度之后的章节；只有叶檀明确允许剧透或要求提前看时，才把 allow_spoilers 设为 true。`;
    readTool.input_schema.properties.allow_spoilers = {
      type: 'boolean',
      description: '默认 false。只有叶檀明确允许剧透或要求读后文时才能设为 true。',
    };
    const original = handlers.get('read_reading_room');
    if (original) {
      handlers.set('read_reading_room', async input => {
        const boundary = await checkSpoilerBoundary(input || {});
        if (!boundary.allowed) return boundary.result;
        return original(input || {});
      });
    }
  }

  const noteTool = tools.find(tool => tool.name === 'generate_reading_chapter_notes');
  if (noteTool) {
    noteTool.description = `${noteTool.description} 默认只生成叶檀当前阅读进度以内的笔记，不能偷偷预读后文；只有她明确允许剧透或要求整本预读时，才把 allow_spoilers 设为 true。`;
    noteTool.input_schema.properties.allow_spoilers = {
      type: 'boolean',
      description: '默认 false。只有叶檀明确允许预读后文时才能设为 true。',
    };
    const original = handlers.get('generate_reading_chapter_notes');
    if (original) {
      handlers.set('generate_reading_chapter_notes', async input => {
        const value = input || {};
        const boundary = await checkSpoilerBoundary(value);
        if (!boundary.allowed) return boundary.result;
        if (value.chapter_index !== undefined && value.chapter_index !== null) return original(value);
        if (value.allow_spoilers === true) return original(value);

        const book = await resolveBook(value);
        if (!book) return original(value);
        const current = await currentChapterIndex(book.id);
        const results = [];
        for (let chapterIndex = 0; chapterIndex <= current; chapterIndex += 1) {
          const result = await original({ ...value, book_id: book.id, chapter_index: chapterIndex });
          if (Array.isArray(result?.results)) results.push(...result.results);
          else results.push({ chapter_index: chapterIndex, status: result?.ok === false ? 'failed' : 'ready', error: result?.error });
        }
        return {
          ok: results.every(item => item.status !== 'failed'),
          book_id: book.id,
          spoiler_boundary: current,
          processed: results.length,
          results,
        };
      });
    }
  }

  const annotationTool = tools.find(tool => tool.name === 'manage_reading_annotation');
  if (annotationTool) {
    annotationTool.input_schema.properties.confirmed = {
      type: 'boolean',
      description: '仅删除时使用；必须在叶檀明确确认目标后才能设为 true。',
    };
    annotationTool.description = `${annotationTool.description} 删除操作在后端也会检查 confirmed=true，不能只凭模型自己判断。`;
    const original = handlers.get('manage_reading_annotation');
    if (original) {
      handlers.set('manage_reading_annotation', input => {
        const value = { ...(input || {}) };
        if (value.color === 'rose') value.color = 'blush';
        if (value.action === 'delete' && value.confirmed !== true) {
          return {
            ok: false,
            confirmation_required: true,
            error: '删除这条划线和批注需要叶檀明确确认。确认目标后再把 confirmed 设为 true。',
          };
        }
        return original(value);
      });
    }
  }

  const bookTool = tools.find(tool => tool.name === 'manage_reading_book');
  if (bookTool) {
    bookTool.input_schema.properties.confirmed = {
      type: 'boolean',
      description: '仅删除整本书时使用；必须在叶檀明确确认准确书名后才能设为 true。',
    };
    bookTool.description = `${bookTool.description} 删除整本书在后端也会检查 confirmed=true。`;
    const original = handlers.get('manage_reading_book');
    if (original) {
      handlers.set('manage_reading_book', input => {
        const value = input || {};
        if (value.action === 'delete' && value.confirmed !== true) {
          return {
            ok: false,
            confirmation_required: true,
            error: '删除整本书会一并删除章节、进度、划线和书签，需要叶檀明确确认准确书名。确认后再把 confirmed 设为 true。',
          };
        }
        return original(value);
      });
    }
  }

  return { tools, handlers, checkSpoilerBoundary };
}

module.exports = {
  createReadingToolSafety,
};