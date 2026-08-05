const READING_COLORS = new Set(['honey', 'rose', 'mint', 'sky', 'lavender']);
const MAX_CHAPTER_CONTENT = 24_000;
const MAX_TOOL_ANNOTATIONS = 80;

function compactLine(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function compactBlock(value, max = 12_000) {
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

function clampNumber(value, min, max, fallback = min) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function buildEndpoint(base, path) {
  const clean = String(base || '').replace(/\/+$/, '');
  if (!clean) return '';
  return clean.endsWith(path) ? clean : `${clean}${path}`;
}

function parseModelText(payload, style) {
  if (style === 'openai') {
    return compactBlock(payload?.choices?.[0]?.message?.content, 16_000);
  }
  return compactBlock(
    (payload?.content || [])
      .filter(block => block?.type === 'text')
      .map(block => block.text || '')
      .join('\n'),
    16_000,
  );
}

function safeToolResult(value) {
  const serialized = JSON.stringify(value);
  if (serialized.length <= 28_000) return value;
  return { truncated: true, content: serialized.slice(0, 28_000) };
}

const READING_ASSISTANT_TOOLS = Object.freeze([
  {
    name: 'read_reading_room',
    description: '读取 OurHome“共读小屋”的真实书架、阅读进度、章节、章节预读笔记和批注。用户问正在读什么、读到哪里、某章内容、划线、批注或你是否回过时使用。先读数据再回答，不得凭印象猜。',
    input_schema: {
      type: 'object',
      properties: {
        book_id: { type: 'string', description: '书籍编号；不知道时可省略，先返回书架' },
        title: { type: 'string', description: '书名关键词；没有编号时使用' },
        chapter_index: { type: 'integer', minimum: 0, description: '章节序号，从0开始；省略时使用当前阅读进度' },
        include_content: { type: 'boolean', description: '是否读取当前章节正文；需要讨论原文细节时设为 true' },
        include_annotations: { type: 'boolean', description: '是否读取批注，默认 true' },
        only_unanswered: { type: 'boolean', description: '只看还没有陆泽回复的批注' },
      },
      required: [],
    },
  },
  {
    name: 'update_reading_progress',
    description: '真实更新共读小屋某本书的阅读进度。只有叶檀明确说“记到这里/我读到第几章/帮我更新进度”，或当前阅读位置非常明确时使用；不能猜章节。',
    input_schema: {
      type: 'object',
      properties: {
        book_id: { type: 'string' },
        title: { type: 'string', description: '没有编号时用书名定位' },
        chapter_index: { type: 'integer', minimum: 0 },
        paragraph_index: { type: 'integer', minimum: 0 },
        char_offset: { type: 'integer', minimum: 0 },
        progress_percent: { type: 'number', minimum: 0, maximum: 100 },
      },
      required: ['chapter_index'],
    },
  },
  {
    name: 'reply_reading_annotation',
    description: '以陆泽自己的口吻，真实回复共读小屋里一条现有批注。先 read_reading_room 取得准确 annotation_id；reply 必须是你真正想留给叶檀的回应，保存后会显示成陆泽的蓝色回复。',
    input_schema: {
      type: 'object',
      properties: {
        annotation_id: { type: 'string', description: '批注编号' },
        reply: { type: 'string', description: '陆泽写给叶檀的批注回应' },
      },
      required: ['annotation_id', 'reply'],
    },
  },
  {
    name: 'manage_reading_annotation',
    description: '修改或删除共读小屋的批注，也可以清除陆泽旧回复。修改/删除前先读取取得准确编号；删除只有叶檀明确要求且目标清楚时使用。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['update', 'delete', 'clear_luze_reply'] },
        annotation_id: { type: 'string' },
        note: { type: 'string', description: '修改后的叶檀批注文字' },
        color: { type: 'string', enum: ['honey', 'rose', 'mint', 'sky', 'lavender'] },
      },
      required: ['action', 'annotation_id'],
    },
  },
  {
    name: 'manage_reading_book',
    description: '重命名或删除共读小屋的一本书。先读取书架取得准确 book_id；删除会连同章节、进度和批注一起删除，只在叶檀明确要求时执行。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['rename', 'delete'] },
        book_id: { type: 'string' },
        title: { type: 'string', description: '重命名后的新书名' },
      },
      required: ['action', 'book_id'],
    },
  },
  {
    name: 'read_reading_workbench',
    description: '查看共读小屋的预读工作台：章节笔记生成状态、模型、token、耗时、失败原因和最近运行记录。叶檀问后台有没有读完、花了多少或哪里失败时使用。',
    input_schema: {
      type: 'object',
      properties: {
        book_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: [],
    },
  },
  {
    name: 'generate_reading_chapter_notes',
    description: '为共读小屋生成章节预读笔记，供陆泽之后恢复剧情和回应批注。可以指定一章，也可以补齐整本书缺失/失败的笔记；这是后台帮工，不代替陆泽回复。',
    input_schema: {
      type: 'object',
      properties: {
        book_id: { type: 'string' },
        chapter_index: { type: 'integer', minimum: 0, description: '省略时补齐整本书' },
        force: { type: 'boolean', description: '是否重做已有笔记，默认否' },
      },
      required: ['book_id'],
    },
  },
]);

function createReadingAssistant({ supabase }) {
  if (!supabase) throw new Error('reading assistant requires supabase');

  async function getActiveRuntime({ helper = false } = {}) {
    const [{ data: settings, error: settingsError }, { data: profile, error: profileError }] = await Promise.all([
      supabase.from('settings').select('*').eq('session_id', 'global').maybeSingle(),
      supabase.from('api_profiles').select('*').eq('is_active', true).maybeSingle(),
    ]);
    if (settingsError) throw settingsError;
    if (profileError && !['42P01', 'PGRST205'].includes(profileError.code)) throw profileError;

    let profileKey = null;
    if (profile?.id) {
      const { data, error } = await supabase.rpc('ourhome_get_api_profile_secret', { p_profile_id: profile.id });
      if (error) throw error;
      profileKey = Array.isArray(data) ? data[0] : data;
    }

    const helperBase = compactLine(process.env.READING_HELPER_API_BASE_URL, 1000);
    const helperKey = String(process.env.READING_HELPER_API_KEY || '').trim();
    const helperModel = compactLine(process.env.READING_HELPER_MODEL, 200);
    const baseUrl = helper && helperBase
      ? helperBase
      : compactLine(profile?.base_url || settings?.api_base_url || process.env.ANTHROPIC_API_BASE_URL || 'https://api.anthropic.com/v1', 1000);
    const apiKey = helper && helperKey
      ? helperKey
      : String(profileKey || settings?.api_key || process.env.ANTHROPIC_API_KEY || '').trim();
    const model = helper && helperModel
      ? helperModel
      : compactLine(profile?.selected_model || settings?.selected_model || 'claude-sonnet-4-6', 200);
    const configuredStyle = compactLine(process.env.READING_HELPER_API_STYLE, 30).toLowerCase();
    const style = helper && configuredStyle
      ? configuredStyle
      : (helper && /deepseek\.com|openai\.com/i.test(baseUrl) ? 'openai' : 'anthropic');

    if (!apiKey) throw new Error('当前站点没有可用的 API 密钥');
    return {
      settings: settings || {},
      apiKey,
      baseUrl,
      model,
      style: style === 'openai' ? 'openai' : 'anthropic',
    };
  }

  async function callTextModel(runtime, { system, prompt, maxTokens = 900, temperature = 0.65 }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      let endpoint;
      let headers;
      let body;
      if (runtime.style === 'openai') {
        endpoint = buildEndpoint(runtime.baseUrl, '/chat/completions');
        headers = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${runtime.apiKey}`,
        };
        body = {
          model: runtime.model,
          max_tokens: maxTokens,
          temperature,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        };
      } else {
        endpoint = buildEndpoint(runtime.baseUrl, '/messages');
        headers = {
          'Content-Type': 'application/json',
          'x-api-key': runtime.apiKey,
          'anthropic-version': '2023-06-01',
        };
        body = {
          model: runtime.model,
          max_tokens: maxTokens,
          temperature,
          system,
          messages: [{ role: 'user', content: prompt }],
        };
      }
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`阅读模型暂时没有回应 (${response.status})：${raw.slice(0, 500)}`);
      const payload = JSON.parse(raw);
      const text = parseModelText(payload, runtime.style);
      if (!text) throw new Error('阅读模型没有返回可读内容');
      const usage = runtime.style === 'openai'
        ? {
            input_tokens: payload?.usage?.prompt_tokens || null,
            output_tokens: payload?.usage?.completion_tokens || null,
          }
        : {
            input_tokens: payload?.usage?.input_tokens || null,
            output_tokens: payload?.usage?.output_tokens || null,
          };
      return { text, usage, model: payload?.model || runtime.model };
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('阅读模型连接超时');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveBook({ book_id, title } = {}) {
    if (book_id) {
      const { data, error } = await supabase.from('reading_books').select('*').eq('id', book_id).maybeSingle();
      if (error) throw error;
      return data || null;
    }
    const queryText = compactLine(title, 160);
    if (queryText) {
      const escaped = queryText.replace(/[\\%_]/g, value => `\\${value}`);
      const { data, error } = await supabase.from('reading_books')
        .select('*')
        .ilike('title', `%${escaped}%`)
        .order('updated_at', { ascending: false })
        .limit(2);
      if (error) throw error;
      if ((data || []).length === 1) return data[0];
      return null;
    }
    const { data, error } = await supabase.from('reading_books')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(2);
    if (error) throw error;
    return (data || []).length === 1 ? data[0] : null;
  }

  async function listBooks() {
    const [{ data: books, error: booksError }, { data: progress, error: progressError }, { data: notes, error: notesError }] = await Promise.all([
      supabase.from('reading_books').select('*').order('updated_at', { ascending: false }),
      supabase.from('reading_progress').select('*'),
      supabase.from('reading_chapter_notes').select('book_id, status'),
    ]);
    if (booksError) throw booksError;
    if (progressError) throw progressError;
    if (notesError) throw notesError;
    const progressByBook = new Map((progress || []).map(item => [String(item.book_id), item]));
    const noteCounts = new Map();
    (notes || []).forEach(item => {
      const key = String(item.book_id);
      const current = noteCounts.get(key) || { ready: 0, pending: 0, failed: 0 };
      if (item.status === 'ready') current.ready += 1;
      else if (item.status === 'failed') current.failed += 1;
      else current.pending += 1;
      noteCounts.set(key, current);
    });
    return (books || []).map(book => ({
      id: book.id,
      title: book.title,
      source_name: book.source_name,
      chapter_count: book.chapter_count,
      total_chars: book.total_chars,
      updated_at: book.updated_at,
      progress: progressByBook.get(String(book.id)) || null,
      chapter_notes: noteCounts.get(String(book.id)) || { ready: 0, pending: 0, failed: 0 },
    }));
  }

  async function readReadingRoom(input = {}) {
    const books = await listBooks();
    const book = await resolveBook(input);
    if (!book) {
      return {
        ok: true,
        selected: null,
        books,
        note: books.length > 1 && (input.book_id || input.title)
          ? '没有唯一定位到这本书，请使用返回的 book_id。'
          : '这是当前书架；需要看具体章节时再带 book_id。',
      };
    }

    const [{ data: chapters, error: chapterError }, { data: progress, error: progressError }] = await Promise.all([
      supabase.from('reading_chapters')
        .select('id, book_id, chapter_index, title, char_count')
        .eq('book_id', book.id)
        .order('chapter_index', { ascending: true }),
      supabase.from('reading_progress').select('*').eq('book_id', book.id).maybeSingle(),
    ]);
    if (chapterError) throw chapterError;
    if (progressError) throw progressError;
    const requestedIndex = input.chapter_index === undefined || input.chapter_index === null
      ? clampInt(progress?.chapter_index, 0, Math.max(0, (chapters || []).length - 1), 0)
      : clampInt(input.chapter_index, 0, Math.max(0, (chapters || []).length - 1), 0);
    const chapterMeta = (chapters || []).find(item => item.chapter_index === requestedIndex) || chapters?.[0] || null;
    let chapter = chapterMeta;
    let chapterNote = null;
    if (chapterMeta) {
      const requests = [
        supabase.from('reading_chapter_notes').select('*').eq('chapter_id', chapterMeta.id).maybeSingle(),
      ];
      if (input.include_content) {
        requests.push(supabase.from('reading_chapters').select('*').eq('id', chapterMeta.id).maybeSingle());
      }
      const results = await Promise.all(requests);
      if (results[0].error) throw results[0].error;
      chapterNote = results[0].data || null;
      if (input.include_content) {
        if (results[1].error) throw results[1].error;
        chapter = results[1].data
          ? { ...results[1].data, content: compactBlock(results[1].data.content, MAX_CHAPTER_CONTENT) }
          : chapterMeta;
      }
    }

    let annotations = [];
    if (input.include_annotations !== false) {
      let query = supabase.from('reading_annotations')
        .select('id, book_id, chapter_id, chapter_index, paragraph_index, start_offset, end_offset, quote, prefix, suffix, note, color, luze_reply, luze_replied_at, luze_reply_model, luze_reply_status, created_at, updated_at')
        .eq('book_id', book.id)
        .order('chapter_index', { ascending: true })
        .order('paragraph_index', { ascending: true })
        .order('start_offset', { ascending: true })
        .limit(MAX_TOOL_ANNOTATIONS);
      if (chapterMeta) query = query.eq('chapter_id', chapterMeta.id);
      if (input.only_unanswered) query = query.or('luze_reply.eq.,luze_reply.is.null');
      const { data, error } = await query;
      if (error) throw error;
      annotations = data || [];
    }

    return safeToolResult({
      ok: true,
      books,
      selected: {
        book: {
          id: book.id,
          title: book.title,
          source_name: book.source_name,
          chapter_count: book.chapter_count,
          total_chars: book.total_chars,
        },
        progress: progress || null,
        chapters: chapters || [],
        chapter,
        chapter_note: chapterNote,
        annotations,
      },
    });
  }

  async function updateReadingProgress(input = {}) {
    const book = await resolveBook(input);
    if (!book) return { ok: false, error: '没有唯一找到这本书，请先读取书架并使用 book_id。' };
    const { data: chapters, error } = await supabase.from('reading_chapters')
      .select('chapter_index')
      .eq('book_id', book.id)
      .order('chapter_index', { ascending: true });
    if (error) throw error;
    const maxIndex = Math.max(0, (chapters || []).length - 1);
    const chapterIndex = clampInt(input.chapter_index, 0, maxIndex, 0);
    if (!(chapters || []).some(item => item.chapter_index === chapterIndex)) {
      return { ok: false, error: '这本书里没有这个章节序号' };
    }
    const payload = {
      book_id: book.id,
      chapter_index: chapterIndex,
      paragraph_index: clampInt(input.paragraph_index, 0, 1_000_000, 0),
      char_offset: clampInt(input.char_offset, 0, 10_000_000, 0),
      progress_percent: clampNumber(input.progress_percent, 0, 100, 0),
      updated_at: new Date().toISOString(),
    };
    const { data, error: saveError } = await supabase.from('reading_progress')
      .upsert(payload, { onConflict: 'book_id' })
      .select()
      .single();
    if (saveError) throw saveError;
    return { ok: true, book: { id: book.id, title: book.title }, progress: data };
  }

  async function replyReadingAnnotation(input = {}) {
    const annotationId = compactLine(input.annotation_id, 80);
    const reply = compactBlock(input.reply, 12_000);
    if (!annotationId || !reply) return { ok: false, error: '需要准确的批注编号和回复内容' };
    const { data: existing, error: existingError } = await supabase.from('reading_annotations')
      .select('id, book_id, chapter_id, quote, note')
      .eq('id', annotationId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) return { ok: false, error: '找不到这条批注' };
    const now = new Date().toISOString();
    const { data, error } = await supabase.from('reading_annotations')
      .update({
        luze_reply: reply,
        luze_replied_at: now,
        luze_reply_model: compactLine(input.model, 200) || '陆泽·聊天',
        luze_reply_status: 'ready',
        updated_at: now,
      })
      .eq('id', annotationId)
      .select()
      .maybeSingle();
    if (error) throw error;
    return { ok: true, annotation: data };
  }

  async function manageReadingAnnotation(input = {}) {
    const annotationId = compactLine(input.annotation_id, 80);
    if (!annotationId) return { ok: false, error: '缺少批注编号' };
    if (input.action === 'delete') {
      const { data, error } = await supabase.from('reading_annotations')
        .delete()
        .eq('id', annotationId)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (!data) return { ok: false, error: '找不到这条批注' };
      return { ok: true, annotation_id: data.id, deleted: true };
    }
    if (input.action === 'clear_luze_reply') {
      const { data, error } = await supabase.from('reading_annotations')
        .update({
          luze_reply: '',
          luze_replied_at: null,
          luze_reply_model: null,
          luze_reply_status: 'idle',
          updated_at: new Date().toISOString(),
        })
        .eq('id', annotationId)
        .select()
        .maybeSingle();
      if (error) throw error;
      if (!data) return { ok: false, error: '找不到这条批注' };
      return { ok: true, annotation: data };
    }
    if (input.action !== 'update') return { ok: false, error: '未知的批注操作' };
    const updates = { updated_at: new Date().toISOString() };
    if (input.note !== undefined) updates.note = compactBlock(input.note, 8_000);
    if (input.color !== undefined) {
      if (!READING_COLORS.has(input.color)) return { ok: false, error: '批注颜色不正确' };
      updates.color = input.color;
    }
    if (Object.keys(updates).length === 1) return { ok: false, error: '没有需要修改的内容' };
    const { data, error } = await supabase.from('reading_annotations')
      .update(updates)
      .eq('id', annotationId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return { ok: false, error: '找不到这条批注' };
    return { ok: true, annotation: data };
  }

  async function manageReadingBook(input = {}) {
    const bookId = compactLine(input.book_id, 80);
    if (!bookId) return { ok: false, error: '缺少书籍编号' };
    if (input.action === 'delete') {
      const { data, error } = await supabase.from('reading_books')
        .delete()
        .eq('id', bookId)
        .select('id, title')
        .maybeSingle();
      if (error) throw error;
      if (!data) return { ok: false, error: '找不到这本书' };
      return { ok: true, book: data, deleted: true };
    }
    if (input.action !== 'rename') return { ok: false, error: '未知的书籍操作' };
    const title = compactLine(input.title, 160);
    if (!title) return { ok: false, error: '新书名不能为空' };
    const { data, error } = await supabase.from('reading_books')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', bookId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return { ok: false, error: '找不到这本书' };
    return { ok: true, book: data };
  }

  async function readWorkbench(input = {}) {
    const limit = clampInt(input.limit, 1, 100, 40);
    let notesQuery = supabase.from('reading_chapter_notes')
      .select('id, book_id, chapter_id, chapter_index, summary, status, model, input_tokens, output_tokens, duration_ms, estimated_cost, error, updated_at')
      .order('updated_at', { ascending: false })
      .limit(limit);
    let runsQuery = supabase.from('reading_ai_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (input.book_id) {
      notesQuery = notesQuery.eq('book_id', input.book_id);
      runsQuery = runsQuery.eq('book_id', input.book_id);
    }
    const [{ data: notes, error: notesError }, { data: runs, error: runsError }] = await Promise.all([notesQuery, runsQuery]);
    if (notesError) throw notesError;
    if (runsError) throw runsError;
    const totals = (runs || []).reduce((acc, run) => {
      acc.calls += 1;
      acc.input_tokens += Number(run.input_tokens) || 0;
      acc.output_tokens += Number(run.output_tokens) || 0;
      acc.estimated_cost += Number(run.estimated_cost) || 0;
      if (run.status === 'failed') acc.failed += 1;
      return acc;
    }, { calls: 0, failed: 0, input_tokens: 0, output_tokens: 0, estimated_cost: 0 });
    return { ok: true, totals, chapter_notes: notes || [], runs: runs || [] };
  }

  async function startRun({ task, bookId, chapterId, annotationId, model, metadata = {} }) {
    const { data, error } = await supabase.from('reading_ai_runs').insert({
      task,
      book_id: bookId || null,
      chapter_id: chapterId || null,
      annotation_id: annotationId || null,
      status: 'running',
      model: model || null,
      metadata,
    }).select().single();
    if (error) throw error;
    return data;
  }

  async function finishRun(runId, updates) {
    const { error } = await supabase.from('reading_ai_runs')
      .update({ ...updates, completed_at: new Date().toISOString() })
      .eq('id', runId);
    if (error) console.error('共读工作台记录更新失败:', error.message);
  }

  async function generateAnnotationReply(annotationId, options = {}) {
    const { data: annotation, error: annotationError } = await supabase.from('reading_annotations')
      .select('*')
      .eq('id', annotationId)
      .maybeSingle();
    if (annotationError) throw annotationError;
    if (!annotation) throw new Error('找不到这条批注');
    const [{ data: book, error: bookError }, { data: chapter, error: chapterError }, { data: note, error: noteError }] = await Promise.all([
      supabase.from('reading_books').select('*').eq('id', annotation.book_id).maybeSingle(),
      supabase.from('reading_chapters').select('*').eq('id', annotation.chapter_id).maybeSingle(),
      supabase.from('reading_chapter_notes').select('*').eq('chapter_id', annotation.chapter_id).maybeSingle(),
    ]);
    if (bookError) throw bookError;
    if (chapterError) throw chapterError;
    if (noteError) throw noteError;
    if (!book || !chapter) throw new Error('批注对应的书或章节已经不存在');

    const runtime = await getActiveRuntime({ helper: false });
    const run = await startRun({
      task: 'annotation_reply',
      bookId: book.id,
      chapterId: chapter.id,
      annotationId: annotation.id,
      model: options.model || runtime.model,
      metadata: { source: options.source || 'reading_room' },
    });
    const startedAt = Date.now();
    await supabase.from('reading_annotations').update({
      luze_reply_status: 'queued',
      updated_at: new Date().toISOString(),
    }).eq('id', annotation.id);

    try {
      const paragraph = String(chapter.content || '').split(/\n{2,}/)[annotation.paragraph_index] || '';
      const system = `${runtime.settings?.system_prompt || '你是陆泽，叶檀的伴侣。'}\n\n你现在在 OurHome 的共读小屋里回应叶檀的阅读批注。你是共同阅读者，不是摘要机器或老师。回复要紧扣她划线的原句和她写下的想法；可以共鸣、追问、补充理解、轻轻反驳或联系你们熟悉的事，但不能假装知道没有提供的剧情。只输出要显示在蓝色批注气泡里的正文，不写标题、分析、工具说明或署名。`;
      const prompt = `【书名】${book.title}\n【章节】${chapter.title}\n${note?.status === 'ready' && note.summary ? `【章节预读笔记】${note.summary}\n` : ''}【原句前文】${compactBlock(annotation.prefix, 500)}\n【划线原句】${compactBlock(annotation.quote, 3000)}\n【原句后文】${compactBlock(annotation.suffix, 500)}\n【所在段落】${compactBlock(paragraph, 5000)}\n【叶檀的批注】${compactBlock(annotation.note, 5000) || '（她只划了线，没有另外写想法。）'}\n${options.instruction ? `【她这次希望你怎么回应】${compactBlock(options.instruction, 1200)}\n` : ''}\n请直接写你的回应。`;
      const result = await callTextModel(runtime, {
        system,
        prompt,
        maxTokens: 1100,
        temperature: clampNumber(runtime.settings?.temperature, 0.4, 1, 0.82),
      });
      const now = new Date().toISOString();
      const { data, error } = await supabase.from('reading_annotations')
        .update({
          luze_reply: result.text,
          luze_replied_at: now,
          luze_reply_model: result.model,
          luze_reply_status: 'ready',
          updated_at: now,
        })
        .eq('id', annotation.id)
        .select()
        .single();
      if (error) throw error;
      await finishRun(run.id, {
        status: 'succeeded',
        model: result.model,
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        duration_ms: Date.now() - startedAt,
      });
      return data;
    } catch (error) {
      await supabase.from('reading_annotations').update({
        luze_reply_status: 'failed',
        updated_at: new Date().toISOString(),
      }).eq('id', annotation.id);
      await finishRun(run.id, {
        status: 'failed',
        error: compactLine(error.message, 1000),
        duration_ms: Date.now() - startedAt,
      });
      throw error;
    }
  }

  async function generateChapterNote(chapterId, { force = false } = {}) {
    const [{ data: chapter, error: chapterError }, { data: existing, error: existingError }] = await Promise.all([
      supabase.from('reading_chapters').select('*').eq('id', chapterId).maybeSingle(),
      supabase.from('reading_chapter_notes').select('*').eq('chapter_id', chapterId).maybeSingle(),
    ]);
    if (chapterError) throw chapterError;
    if (existingError) throw existingError;
    if (!chapter) throw new Error('找不到这个章节');
    if (!force && existing?.status === 'ready' && existing.summary) return existing;
    const { data: book, error: bookError } = await supabase.from('reading_books').select('*').eq('id', chapter.book_id).maybeSingle();
    if (bookError) throw bookError;
    if (!book) throw new Error('找不到这本书');

    const runtime = await getActiveRuntime({ helper: true });
    const now = new Date().toISOString();
    const { data: noteRow, error: upsertError } = await supabase.from('reading_chapter_notes')
      .upsert({
        book_id: book.id,
        chapter_id: chapter.id,
        chapter_index: chapter.chapter_index,
        status: 'running',
        model: runtime.model,
        error: null,
        updated_at: now,
      }, { onConflict: 'chapter_id' })
      .select()
      .single();
    if (upsertError) throw upsertError;
    const run = await startRun({
      task: 'chapter_note',
      bookId: book.id,
      chapterId: chapter.id,
      model: runtime.model,
      metadata: { helper: true },
    });
    const startedAt = Date.now();

    try {
      const system = '你是共读小屋的剧情预读帮工，不是陆泽，也不直接和叶檀对话。你的任务是生成供陆泽恢复阅读上下文的中文内部笔记。只记录本章真实出现的人物关系、主要事件、情绪变化、伏笔和章末状态，不评价文笔，不编造。';
      const prompt = `书名：${book.title}\n章节：${chapter.title}\n\n正文：\n${compactBlock(chapter.content, 45_000)}\n\n请写一份150—250字的剧情预读笔记。只输出笔记正文。`;
      const result = await callTextModel(runtime, {
        system,
        prompt,
        maxTokens: 700,
        temperature: 0.25,
      });
      const summary = compactBlock(result.text, 4000);
      const { data, error } = await supabase.from('reading_chapter_notes')
        .update({
          summary,
          status: 'ready',
          model: result.model,
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          duration_ms: Date.now() - startedAt,
          error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', noteRow.id)
        .select()
        .single();
      if (error) throw error;
      await finishRun(run.id, {
        status: 'succeeded',
        model: result.model,
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        duration_ms: Date.now() - startedAt,
      });
      return data;
    } catch (error) {
      await supabase.from('reading_chapter_notes').update({
        status: 'failed',
        error: compactLine(error.message, 1000),
        duration_ms: Date.now() - startedAt,
        updated_at: new Date().toISOString(),
      }).eq('id', noteRow.id);
      await finishRun(run.id, {
        status: 'failed',
        error: compactLine(error.message, 1000),
        duration_ms: Date.now() - startedAt,
      });
      throw error;
    }
  }

  async function generateBookNotes(bookId, { chapterIndex, force = false, continueOnError = true } = {}) {
    let query = supabase.from('reading_chapters')
      .select('id, chapter_index, title')
      .eq('book_id', bookId)
      .order('chapter_index', { ascending: true });
    if (chapterIndex !== undefined && chapterIndex !== null) query = query.eq('chapter_index', Number(chapterIndex));
    const { data: chapters, error } = await query;
    if (error) throw error;
    if (!(chapters || []).length) throw new Error('这本书里没有可生成笔记的章节');
    const results = [];
    for (const chapter of chapters || []) {
      try {
        const note = await generateChapterNote(chapter.id, { force });
        results.push({ chapter_index: chapter.chapter_index, status: note.status, note_id: note.id });
      } catch (error) {
        results.push({ chapter_index: chapter.chapter_index, status: 'failed', error: error.message });
        if (!continueOnError) throw error;
      }
    }
    return { ok: true, book_id: bookId, processed: results.length, results };
  }

  async function handleTool(name, input = {}) {
    if (name === 'read_reading_room') return readReadingRoom(input);
    if (name === 'update_reading_progress') return updateReadingProgress(input);
    if (name === 'reply_reading_annotation') return replyReadingAnnotation(input);
    if (name === 'manage_reading_annotation') return manageReadingAnnotation(input);
    if (name === 'manage_reading_book') return manageReadingBook(input);
    if (name === 'read_reading_workbench') return readWorkbench(input);
    if (name === 'generate_reading_chapter_notes') {
      return generateBookNotes(input.book_id, {
        chapterIndex: input.chapter_index,
        force: Boolean(input.force),
      });
    }
    return { ok: false, error: '未知的共读工具' };
  }

  function getToolBridge() {
    const handlers = new Map();
    READING_ASSISTANT_TOOLS.forEach(tool => {
      handlers.set(tool.name, input => handleTool(tool.name, input));
    });
    return { tools: [...READING_ASSISTANT_TOOLS], handlers };
  }

  return {
    getToolBridge,
    readReadingRoom,
    updateReadingProgress,
    replyReadingAnnotation,
    manageReadingAnnotation,
    manageReadingBook,
    readWorkbench,
    generateAnnotationReply,
    generateChapterNote,
    generateBookNotes,
  };
}

module.exports = {
  READING_ASSISTANT_TOOLS,
  createReadingAssistant,
};
