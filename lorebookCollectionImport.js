'use strict';

const crypto = require('crypto');

const MAX_BOOKS_PER_COLLECTION = 60;
const MAX_ENTRY_CONTENT_CHARS = 40_000;
const VALID_SCOPES = new Set(['chat', 'theater', 'both']);

function cleanText(value, max = 40_000) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, max);
}

function cleanLine(value, max = 160) {
  return cleanText(value, max).replace(/\n+/g, ' ').trim();
}

function normalizeTitle(value) {
  return cleanLine(value, 140)
    .replace(/^\d+\s*[.、]\s*/, '')
    .replace(/^《|》$/g, '')
    .replace(/\s*(?:v)?\d+(?:\.\d+)?$/i, '')
    .trim();
}

function parseKeywordLine(value) {
  const match = String(value || '').match(/(?:请设置关键词|keywords?)\s*[:：]\s*(.+)$/i);
  if (!match) return [];
  const text = match[1].trim();
  if (/^无(?:$|[（(、，,\s])/u.test(text) || /^none\b/i.test(text)) return [];
  return [...new Set(text.split(/[,，、]/).map(item => cleanLine(item, 180)).filter(Boolean))].slice(0, 40);
}

function collectCatalogTitles(lines, markerIndex) {
  const titles = [];
  for (const line of lines.slice(0, markerIndex)) {
    for (const match of String(line).matchAll(/《([^》]{1,100})》/g)) {
      const title = cleanLine(match[1], 120);
      if (title && !titles.includes(title)) titles.push(title);
    }
  }
  return titles.sort((a, b) => b.length - a.length);
}

function collectConstantExceptions(lines, markerIndex) {
  const set = new Set();
  for (const line of lines.slice(Math.max(0, markerIndex - 2), markerIndex + 8)) {
    if (!/其他都是常驻世界书/.test(line)) continue;
    for (const match of String(line).matchAll(/《([^》]+)》/g)) set.add(normalizeTitle(match[1]));
  }
  return set;
}

function canonicalHeading(line, catalogTitles) {
  const value = cleanLine(line, 180);
  if (!value || value.length > 100) return '';
  for (const title of catalogTitles) {
    if (value === title || value.startsWith(`${title}（`) || value.startsWith(`${title}(`)) return title;
  }
  return '';
}

function parseLorebookCollection(rawText, sourceName = '') {
  const text = String(rawText || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n').map(line => line.trim());
  const markerIndex = lines.findIndex(line => /后面是世界书正文部分/.test(line));
  if (markerIndex < 0) return null;

  const catalogTitles = collectCatalogTitles(lines, markerIndex);
  if (catalogTitles.length < 3) return null;
  const constantExceptions = collectConstantExceptions(lines, markerIndex);
  const headings = [];

  for (let index = markerIndex + 1; index < lines.length; index += 1) {
    const title = canonicalHeading(lines[index], catalogTitles);
    if (!title) continue;
    const previous = headings[headings.length - 1];
    if (previous && previous.title === title && index - previous.index <= 2) continue;
    headings.push({ index, title });
  }

  if (headings.length < 3) return null;
  const books = [];
  for (let i = 0; i < headings.length && books.length < MAX_BOOKS_PER_COLLECTION; i += 1) {
    const current = headings[i];
    const end = headings[i + 1]?.index ?? lines.length;
    const bodyLines = lines.slice(current.index + 1, end);
    const content = cleanText(bodyLines.join('\n'), MAX_ENTRY_CONTENT_CHARS);
    if (!content) continue;
    const keys = bodyLines.flatMap(parseKeywordLine);
    const title = cleanLine(current.title, 120);
    const constant = !constantExceptions.has(normalizeTitle(title));
    books.push({
      name: title,
      description: `从《${cleanLine(sourceName.replace(/\.[^.]+$/, ''), 100) || '世界书合集'}》导入`,
      entry: {
        name: '完整设定',
        content,
        keys: [...new Set(keys)].slice(0, 40),
        constant,
      },
    });
  }
  return books.length >= 3 ? books : null;
}

function fingerprint(value) {
  return crypto.createHash('sha1').update(cleanText(value, MAX_ENTRY_CONTENT_CHARS).replace(/\s+/g, ' ')).digest('hex');
}

async function importCollectionBooks(supabase, books, {
  sourceName = '',
  applyScope = 'chat',
  enabled = false,
} = {}) {
  const scope = VALID_SCOPES.has(String(applyScope)) ? String(applyScope) : 'chat';
  const existingBooksResult = await supabase.from('lorebooks').select('id,name,source_name');
  if (existingBooksResult.error) throw existingBooksResult.error;
  const existingEntriesResult = await supabase.from('lorebook_entries').select('lorebook_id,content');
  if (existingEntriesResult.error) throw existingEntriesResult.error;

  const existingNames = new Set((existingBooksResult.data || []).map(row => cleanLine(row.name, 120).toLocaleLowerCase()));
  const existingFingerprints = new Set((existingEntriesResult.data || []).map(row => fingerprint(row.content)));
  const created = [];
  const skipped = [];

  for (const item of books.slice(0, MAX_BOOKS_PER_COLLECTION)) {
    const nameKey = cleanLine(item.name, 120).toLocaleLowerCase();
    const contentFingerprint = fingerprint(item.entry?.content || '');
    if (existingNames.has(nameKey) || existingFingerprints.has(contentFingerprint)) {
      skipped.push({ name: item.name, reason: 'duplicate' });
      continue;
    }

    const bookRow = {
      name: cleanLine(item.name, 120) || '未命名世界书',
      description: cleanText(item.description, 2000),
      enabled: Boolean(enabled),
      apply_scope: scope,
      target_book_id: null,
      scan_depth: 12,
      token_budget: 2000,
      recursive_scanning: false,
      source_format: 'ourhome_collection_docx',
      source_name: cleanLine(sourceName, 240) || null,
      raw_metadata: { collection_import: true },
    };
    const insertedBook = await supabase.from('lorebooks').insert(bookRow).select().single();
    if (insertedBook.error) throw insertedBook.error;

    const entryRow = {
      lorebook_id: insertedBook.data.id,
      name: cleanLine(item.entry?.name, 120) || '完整设定',
      comment: '',
      content: cleanText(item.entry?.content, MAX_ENTRY_CONTENT_CHARS),
      keys: Array.isArray(item.entry?.keys) ? item.entry.keys.slice(0, 40) : [],
      secondary_keys: [],
      selective: false,
      constant: Boolean(item.entry?.constant),
      use_regex: false,
      enabled: true,
      insertion_order: 0,
      priority: 0,
      position: 'after_character',
      extensions: { collection_import: true },
    };
    const insertedEntry = await supabase.from('lorebook_entries').insert(entryRow).select().single();
    if (insertedEntry.error) {
      await supabase.from('lorebooks').delete().eq('id', insertedBook.data.id);
      throw insertedEntry.error;
    }
    existingNames.add(nameKey);
    existingFingerprints.add(contentFingerprint);
    created.push({ ...insertedBook.data, entries: [insertedEntry.data] });
  }

  return { created, skipped };
}

function registerLorebookCollectionRoute(app, { supabase, upload, extractImportFile }) {
  app.post('/lorebooks/import-collection', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: '先选择世界书合集文件。' });
      const raw = await extractImportFile(req.file);
      const parsed = parseLorebookCollection(raw, req.file.originalname || '');
      if (!parsed) return res.status(422).json({ error: '这不是可自动拆分的世界书合集。' });
      const result = await importCollectionBooks(supabase, parsed, {
        sourceName: req.file.originalname || '',
        applyScope: req.body?.apply_scope,
        enabled: String(req.body?.enabled || '').toLowerCase() === 'true',
      });
      res.json({
        success: true,
        collection: true,
        created: result.created,
        skipped: result.skipped,
        created_count: result.created.length,
        skipped_count: result.skipped.length,
      });
    } catch (error) {
      res.status(400).json({ error: error.message || '世界书合集没有导入成功' });
    }
  });
}

module.exports = {
  canonicalHeading,
  collectCatalogTitles,
  collectConstantExceptions,
  fingerprint,
  importCollectionBooks,
  parseKeywordLine,
  parseLorebookCollection,
  registerLorebookCollectionRoute,
};
