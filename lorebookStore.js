const MAX_LOREBOOKS = 80;
const MAX_ENTRIES_PER_BOOK = 500;
const MAX_ENTRY_CONTENT_CHARS = 40_000;
const MAX_COMPILED_CHARS = 30_000;
const LOREBOOK_SCOPES = ['chat', 'theater', 'both'];
const ENTRY_POSITIONS = ['before_character', 'after_character', 'before_examples', 'after_examples'];

function cleanText(value, max = 20_000) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, max);
}

function cleanLine(value, max = 120, fallback = '') {
  return cleanText(value, max).replace(/\n+/g, ' ') || fallback;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function normalizeScope(value, fallback = 'theater') {
  const scope = String(value || '').trim().toLowerCase();
  return LOREBOOK_SCOPES.includes(scope) ? scope : fallback;
}

function normalizeStringList(value, maxItems = 40) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,，\n]/);
  return [...new Set(raw.map(item => cleanLine(item, 180)).filter(Boolean))].slice(0, maxItems);
}

function normalizeLorebookInput(value = {}, { partial = false } = {}) {
  const normalized = {};
  const set = (key, next) => {
    if (!partial || Object.prototype.hasOwnProperty.call(value, key)) normalized[key] = next;
  };
  set('name', cleanLine(value.name, 120, '未命名世界书'));
  set('description', cleanText(value.description, 2000));
  set('enabled', value.enabled !== false);
  set('apply_scope', normalizeScope(value.apply_scope));
  set('target_book_id', cleanLine(value.target_book_id, 80) || null);
  set('scan_depth', clampInteger(value.scan_depth, 1, 100, 12));
  set('token_budget', clampInteger(value.token_budget, 128, 12_000, 2000));
  set('recursive_scanning', Boolean(value.recursive_scanning));
  set('source_format', cleanLine(value.source_format, 80, 'ourhome'));
  set('source_name', cleanLine(value.source_name, 240) || null);
  set('raw_metadata', value.raw_metadata && typeof value.raw_metadata === 'object' ? value.raw_metadata : {});
  return normalized;
}

function normalizeEntryInput(value = {}, { partial = false } = {}) {
  const normalized = {};
  const set = (key, next) => {
    if (!partial || Object.prototype.hasOwnProperty.call(value, key)) normalized[key] = next;
  };
  set('name', cleanLine(value.name || value.comment, 120, '未命名条目'));
  set('comment', cleanText(value.comment, 500));
  set('content', cleanText(value.content, MAX_ENTRY_CONTENT_CHARS));
  set('keys', normalizeStringList(value.keys ?? value.key));
  set('secondary_keys', normalizeStringList(value.secondary_keys ?? value.keysecondary ?? value.secondaryKeys));
  set('selective', Boolean(value.selective));
  set('constant', Boolean(value.constant ?? value.always_active ?? value.alwaysActive));
  set('use_regex', Boolean(value.use_regex ?? value.useRegex));
  set('enabled', value.enabled !== false && value.disable !== true);
  set('insertion_order', clampInteger(value.insertion_order ?? value.insertionOrder ?? value.order, -100_000, 100_000, 0));
  set('priority', clampInteger(value.priority ?? value.weight, -100_000, 100_000, 0));
  const positionMap = { 0: 'before_character', 1: 'after_character', 2: 'before_examples', 3: 'after_examples' };
  const position = cleanLine(positionMap[value.position] || value.position, 40).toLowerCase();
  set('position', ENTRY_POSITIONS.includes(position) ? position : 'after_character');
  set('extensions', value.extensions && typeof value.extensions === 'object' ? value.extensions : {});
  return normalized;
}

function entriesFromUnknown(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function parseLorebookImport(rawValue, sourceName = '') {
  const rawText = typeof rawValue === 'string' ? rawValue.trim() : '';
  let parsed = rawValue;
  if (rawText) {
    try { parsed = JSON.parse(rawText); } catch { parsed = null; }
  }

  if (!parsed || typeof parsed !== 'object') {
    const content = cleanText(rawText, MAX_ENTRY_CONTENT_CHARS);
    if (!content) throw new Error('这个文件里没有读到世界书内容。');
    return {
      book: normalizeLorebookInput({
        name: cleanLine(sourceName.replace(/\.[^.]+$/, ''), 120, '导入的世界书'),
        source_format: 'plain_text',
        source_name: sourceName,
      }),
      entries: [normalizeEntryInput({ name: '完整设定', content, constant: true })],
    };
  }

  let sourceFormat = cleanLine(parsed.spec, 80) || 'compatible_json';
  let data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data) ? parsed.data : parsed;
  if (data.character_book && typeof data.character_book === 'object') {
    data = data.character_book;
    sourceFormat = cleanLine(parsed.spec, 80) || 'character_card';
  }
  if ((parsed.type === 'risu' || data.type === 'risu') && Array.isArray(parsed.data || data.data)) {
    data = { ...data, entries: parsed.data || data.data };
    sourceFormat = 'risu';
  }

  const rawEntries = entriesFromUnknown(data.entries ?? data.data);
  if (!rawEntries.length && data.content) rawEntries.push(data);
  const entries = rawEntries
    .map((entry, index) => normalizeEntryInput({
      ...entry,
      name: entry.name || entry.comment || `条目 ${index + 1}`,
      constant: entry.constant ?? entry.always_active ?? entry.alwaysActive,
      insertion_order: entry.insertion_order ?? entry.insertionOrder ?? entry.order ?? index,
      extensions: {
        ...(entry.extensions && typeof entry.extensions === 'object' ? entry.extensions : {}),
        imported_unknown: Object.fromEntries(Object.entries(entry).filter(([key]) => ![
          'name', 'comment', 'content', 'keys', 'key', 'secondary_keys', 'keysecondary', 'secondaryKeys',
          'selective', 'constant', 'always_active', 'alwaysActive', 'use_regex', 'useRegex', 'enabled',
          'disable', 'insertion_order', 'insertionOrder', 'order', 'priority', 'weight', 'position', 'extensions',
        ].includes(key))),
      },
    }))
    .filter(entry => entry.content);
  if (!entries.length) throw new Error('这个 JSON 里没有找到可用的世界书条目。');

  const knownBookFields = new Set([
    'name', 'description', 'scan_depth', 'token_budget', 'recursive_scanning', 'entries', 'data',
    'character_book', 'extensions', 'type',
  ]);
  return {
    book: normalizeLorebookInput({
      name: data.name || cleanLine(sourceName.replace(/\.[^.]+$/, ''), 120, '导入的世界书'),
      description: data.description || '',
      scan_depth: data.scan_depth,
      token_budget: data.token_budget,
      recursive_scanning: data.recursive_scanning,
      source_format: sourceFormat,
      source_name: sourceName,
      raw_metadata: {
        spec: parsed.spec || null,
        extensions: data.extensions || {},
        imported_unknown: Object.fromEntries(Object.entries(data).filter(([key]) => !knownBookFields.has(key))),
      },
    }),
    entries,
  };
}

function approximateTokens(value) {
  let ascii = 0;
  let other = 0;
  for (const char of String(value || '')) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

function clipTextToApproxTokens(value, maxTokens) {
  const text = String(value || '');
  const budget = Math.max(0, Math.floor(Number(maxTokens) || 0));
  if (!text || budget <= 0) return '';
  if (approximateTokens(text) <= budget) return text;

  const marker = '\n…（本条世界书已按本轮预算截断）';
  const markerTokens = approximateTokens(marker);
  if (budget <= markerTokens + 8) return '';
  const maxUnits = (budget - markerTokens) * 4;
  let usedUnits = 0;
  let clipped = '';
  for (const char of text) {
    const units = char.charCodeAt(0) <= 0x7f ? 1 : 4;
    if (usedUnits + units > maxUnits) break;
    clipped += char;
    usedUnits += units;
  }
  return `${clipped.trimEnd()}${marker}`;
}

function truncateCompiledContext(value, maxChars = MAX_COMPILED_CHARS) {
  const limit = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (!limit) return '';
  const text = cleanText(value, limit + 1);
  if (text.length <= limit) return text;

  const marker = '\n…（世界书上下文达到本轮总上限）';
  const prefixLimit = Math.max(0, limit - marker.length);
  let prefix = text.slice(0, prefixLimit);
  const candidates = ['\n\n', '\n', '。', '！', '？'].map(token => prefix.lastIndexOf(token));
  const boundary = Math.max(...candidates);
  if (boundary >= Math.floor(prefixLimit * 0.8)) prefix = prefix.slice(0, boundary + 1);
  return `${prefix.trimEnd()}${marker}`;
}

function safeRegex(pattern) {
  const text = cleanLine(pattern, 180);
  if (!text) return null;
  if (/\\[1-9]|\(\?<|\(\?=|\(\?!/.test(text)) return null;
  if (/(?:\*|\+|\{\d+(?:,\d*)?\})[^\n]{0,18}(?:\*|\+|\{\d+(?:,\d*)?\})/.test(text)) return null;
  try { return new RegExp(text, 'iu'); } catch { return null; }
}

function keywordMatches(keyword, haystack, useRegex) {
  const needle = cleanLine(keyword, 180);
  if (!needle) return false;
  if (useRegex) return safeRegex(needle)?.test(haystack) || false;
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

function entryMatches(entry, haystack) {
  if (entry.enabled === false) return false;
  if (entry.constant) return true;
  const primary = normalizeStringList(entry.keys);
  if (!primary.some(key => keywordMatches(key, haystack, entry.use_regex))) return false;
  if (!entry.selective) return true;
  const secondary = normalizeStringList(entry.secondary_keys);
  return secondary.length > 0 && secondary.some(key => keywordMatches(key, haystack, entry.use_regex));
}

function selectLorebookEntries(book, entries, historyMessages = []) {
  const depth = clampInteger(book.scan_depth, 1, 100, 12);
  let scanText = (Array.isArray(historyMessages) ? historyMessages : [historyMessages])
    .slice(-depth)
    .map(value => cleanText(value, 6000))
    .filter(Boolean)
    .join('\n');
  const sorted = entries
    .filter(entry => entry.enabled !== false)
    .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0)
      || (Number(a.insertion_order) || 0) - (Number(b.insertion_order) || 0));
  const matched = [];
  const seen = new Set();
  const passes = book.recursive_scanning ? 2 : 1;
  for (let pass = 0; pass < passes; pass += 1) {
    const newlyMatched = sorted.filter(entry => !seen.has(String(entry.id || entry.name)) && entryMatches(entry, scanText));
    if (!newlyMatched.length) break;
    newlyMatched.forEach(entry => {
      seen.add(String(entry.id || entry.name));
      matched.push(entry);
    });
    scanText += `\n${newlyMatched.map(entry => entry.content).join('\n')}`;
  }

  const budget = clampInteger(book.token_budget, 128, 12_000, 2000);
  const selected = [];
  let used = 0;
  for (const entry of matched) {
    const header = `${entry.name || ''}\n`;
    const headerCost = approximateTokens(header);
    const remaining = budget - used - headerCost;
    if (remaining <= 0) break;
    const content = clipTextToApproxTokens(entry.content || '', remaining);
    if (!content) continue;
    const selectedEntry = content === entry.content ? entry : { ...entry, content };
    const cost = approximateTokens(`${header}${content}`);
    if (used + cost > budget) continue;
    selected.push(selectedEntry);
    used += cost;
    if (used >= budget) break;
  }
  return selected.sort((a, b) => (Number(a.insertion_order) || 0) - (Number(b.insertion_order) || 0));
}

function compileLorebookContext(books = [], entries = [], historyMessages = [], { scope = 'chat', targetBookId = null } = {}) {
  const targetScope = normalizeScope(scope, 'chat');
  const entryMap = new Map();
  entries.forEach(entry => entryMap.set(String(entry.lorebook_id), [...(entryMap.get(String(entry.lorebook_id)) || []), entry]));
  const sections = [];
  for (const book of books) {
    if (book.enabled === false) continue;
    if (![targetScope, 'both'].includes(normalizeScope(book.apply_scope))) continue;
    const boundTarget = book.target_book_id ? String(book.target_book_id) : null;
    if (targetScope === 'chat' && boundTarget) continue;
    if (targetScope === 'theater' && boundTarget && boundTarget !== String(targetBookId || '')) continue;
    const active = selectLorebookEntries(book, entryMap.get(String(book.id)) || [], historyMessages);
    if (!active.length) continue;
    sections.push(`【世界书：${cleanLine(book.name, 120, '未命名')}】\n${active.map(entry => {
      const title = cleanLine(entry.name, 120);
      return `${title ? `【${title}】\n` : ''}${cleanText(entry.content, MAX_ENTRY_CONTENT_CHARS)}`;
    }).join('\n\n')}`);
  }
  return truncateCompiledContext(sections.join('\n\n'), MAX_COMPILED_CHARS);
}

async function loadCompiledLorebookContext(supabase, options = {}) {
  const scope = normalizeScope(options.scope, 'chat');
  const { data: books, error: bookError } = await supabase
    .from('lorebooks')
    .select('*')
    .eq('enabled', true)
    .in('apply_scope', [scope, 'both'])
    .order('created_at', { ascending: true })
    .limit(MAX_LOREBOOKS);
  if (bookError) {
    if (['42P01', 'PGRST205'].includes(bookError.code)) return '';
    throw bookError;
  }
  if (!books?.length) return '';
  const { data: entries, error: entryError } = await supabase
    .from('lorebook_entries')
    .select('*')
    .in('lorebook_id', books.map(book => book.id))
    .eq('enabled', true)
    .limit(MAX_LOREBOOKS * MAX_ENTRIES_PER_BOOK);
  if (entryError) {
    if (['42P01', 'PGRST205'].includes(entryError.code)) return '';
    throw entryError;
  }
  return compileLorebookContext(books, entries || [], options.historyMessages || [], options);
}

function createLorebookStore(supabase) {
  async function listBooks() {
    const { data: books, error } = await supabase.from('lorebooks').select('*').order('created_at', { ascending: true }).limit(MAX_LOREBOOKS);
    if (error) throw error;
    const ids = (books || []).map(book => book.id);
    let entries = [];
    if (ids.length) {
      const result = await supabase.from('lorebook_entries').select('*').in('lorebook_id', ids).order('insertion_order', { ascending: true }).limit(MAX_LOREBOOKS * MAX_ENTRIES_PER_BOOK);
      if (result.error) throw result.error;
      entries = result.data || [];
    }
    const entriesByBook = new Map();
    for (const entry of entries) {
      const key = String(entry.lorebook_id);
      entriesByBook.set(key, [...(entriesByBook.get(key) || []), entry]);
    }
    return (books || []).map(book => ({ ...book, entries: entriesByBook.get(String(book.id)) || [] }));
  }

  async function createBook(rawBook = {}, rawEntries = []) {
    const book = normalizeLorebookInput(rawBook);
    const { data, error } = await supabase.from('lorebooks').insert(book).select().single();
    if (error) throw error;
    const entries = rawEntries.map(entry => ({ ...normalizeEntryInput(entry), lorebook_id: data.id })).filter(entry => entry.content).slice(0, MAX_ENTRIES_PER_BOOK);
    if (entries.length) {
      const result = await supabase.from('lorebook_entries').insert(entries).select();
      if (result.error) {
        await supabase.from('lorebooks').delete().eq('id', data.id);
        throw result.error;
      }
      return { ...data, entries: result.data || [] };
    }
    return { ...data, entries: [] };
  }

  async function updateBook(id, rawValue = {}) {
    const patch = { ...normalizeLorebookInput(rawValue, { partial: true }), updated_at: new Date().toISOString() };
    const { data, error } = await supabase.from('lorebooks').update(patch).eq('id', id).select().maybeSingle();
    if (error) throw error;
    return data;
  }

  async function deleteBook(id) {
    const { data, error } = await supabase.from('lorebooks').delete().eq('id', id).select('id').maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }

  async function createEntry(bookId, rawValue = {}) {
    const value = { ...normalizeEntryInput(rawValue), lorebook_id: bookId };
    if (!value.content) throw new Error('世界书条目正文不能为空。');
    const { data, error } = await supabase.from('lorebook_entries').insert(value).select().single();
    if (error) throw error;
    return data;
  }

  async function updateEntry(id, rawValue = {}) {
    const patch = { ...normalizeEntryInput(rawValue, { partial: true }), updated_at: new Date().toISOString() };
    if (Object.prototype.hasOwnProperty.call(patch, 'content') && !patch.content) throw new Error('世界书条目正文不能为空。');
    const { data, error } = await supabase.from('lorebook_entries').update(patch).eq('id', id).select().maybeSingle();
    if (error) throw error;
    return data;
  }

  async function deleteEntry(id) {
    const { data, error } = await supabase.from('lorebook_entries').delete().eq('id', id).select('id').maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }

  return { listBooks, createBook, updateBook, deleteBook, createEntry, updateEntry, deleteEntry };
}

function exportLorebookV3(book) {
  return {
    spec: 'lorebook_v3',
    spec_version: '3.0',
    data: {
      name: book.name,
      description: book.description || '',
      scan_depth: book.scan_depth,
      token_budget: book.token_budget,
      recursive_scanning: Boolean(book.recursive_scanning),
      extensions: book.raw_metadata?.extensions || {},
      entries: (book.entries || []).map(entry => ({
        keys: entry.keys || [],
        secondary_keys: entry.secondary_keys || [],
        content: entry.content,
        enabled: entry.enabled !== false,
        insertion_order: entry.insertion_order || 0,
        case_sensitive: false,
        name: entry.name || '',
        priority: entry.priority || 0,
        selective: Boolean(entry.selective),
        constant: Boolean(entry.constant),
        position: entry.position || 'after_character',
        use_regex: Boolean(entry.use_regex),
        extensions: entry.extensions || {},
      })),
    },
  };
}

function registerLorebookRoutes(app, { supabase, upload, extractImportFile }) {
  const store = createLorebookStore(supabase);
  app.get('/lorebooks', async (_req, res) => {
    try { res.json(await store.listBooks()); } catch (error) { res.status(500).json({ error: error.message || '世界书库没有打开' }); }
  });
  app.post('/lorebooks', async (req, res) => {
    try { res.json(await store.createBook(req.body || {}, req.body?.entries || [])); } catch (error) { res.status(400).json({ error: error.message || '世界书没有保存成功' }); }
  });
  app.patch('/lorebooks/:id', async (req, res) => {
    try {
      const book = await store.updateBook(req.params.id, req.body || {});
      if (!book) return res.status(404).json({ error: '找不到这本世界书' });
      res.json(book);
    } catch (error) { res.status(400).json({ error: error.message || '世界书没有修改成功' }); }
  });
  app.delete('/lorebooks/:id', async (req, res) => {
    try {
      if (!await store.deleteBook(req.params.id)) return res.status(404).json({ error: '找不到这本世界书' });
      res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message || '世界书没有删除成功' }); }
  });
  app.post('/lorebooks/:id/entries', async (req, res) => {
    try { res.json(await store.createEntry(req.params.id, req.body || {})); } catch (error) { res.status(400).json({ error: error.message || '条目没有保存成功' }); }
  });
  app.patch('/lorebook-entries/:id', async (req, res) => {
    try {
      const entry = await store.updateEntry(req.params.id, req.body || {});
      if (!entry) return res.status(404).json({ error: '找不到这条世界书内容' });
      res.json(entry);
    } catch (error) { res.status(400).json({ error: error.message || '条目没有修改成功' }); }
  });
  app.delete('/lorebook-entries/:id', async (req, res) => {
    try {
      if (!await store.deleteEntry(req.params.id)) return res.status(404).json({ error: '找不到这条世界书内容' });
      res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message || '条目没有删除成功' }); }
  });
  app.post('/lorebooks/import', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: '先选择一个世界书文件。' });
      const raw = await extractImportFile(req.file, { allowJson: true });
      const parsed = parseLorebookImport(raw, req.file.originalname || '');
      parsed.book.apply_scope = normalizeScope(req.body?.apply_scope);
      parsed.book.target_book_id = cleanLine(req.body?.target_book_id, 80) || null;
      res.json(await store.createBook(parsed.book, parsed.entries));
    } catch (error) { res.status(400).json({ error: error.message || '世界书没有导入成功' }); }
  });
  app.get('/lorebooks/:id/export', async (req, res) => {
    try {
      const book = (await store.listBooks()).find(item => String(item.id) === String(req.params.id));
      if (!book) return res.status(404).json({ error: '找不到这本世界书' });
      res.setHeader('Content-Disposition', `attachment; filename=\"lorebook-${book.id}.json\"`);
      res.json(exportLorebookV3(book));
    } catch (error) { res.status(500).json({ error: error.message || '世界书没有导出成功' }); }
  });
  return store;
}

module.exports = {
  MAX_LOREBOOKS,
  MAX_ENTRIES_PER_BOOK,
  LOREBOOK_SCOPES,
  cleanText,
  normalizeLorebookInput,
  normalizeEntryInput,
  parseLorebookImport,
  approximateTokens,
  clipTextToApproxTokens,
  truncateCompiledContext,
  safeRegex,
  entryMatches,
  selectLorebookEntries,
  compileLorebookContext,
  loadCompiledLorebookContext,
  createLorebookStore,
  exportLorebookV3,
  registerLorebookRoutes,
};