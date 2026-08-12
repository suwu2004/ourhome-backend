const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const mammoth = require('mammoth');

const READING_FILE_KINDS = Object.freeze({
  txt: ['.txt', '.md'],
  docx: ['.docx'],
  pdf: ['.pdf'],
  epub: ['.epub'],
});

const MIME_KIND = new Map([
  ['text/plain', 'txt'],
  ['text/markdown', 'txt'],
  ['application/markdown', 'txt'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/pdf', 'pdf'],
  ['application/epub+zip', 'epub'],
]);

function detectReadingFileKind(file = {}) {
  const name = String(file.originalname || file.name || '').toLowerCase();
  const extension = path.extname(name);
  if (extension === '.md') return 'md';
  for (const [kind, extensions] of Object.entries(READING_FILE_KINDS)) {
    if (extensions.includes(extension)) return kind;
  }
  return MIME_KIND.get(String(file.mimetype || file.type || '').toLowerCase()) || null;
}

function decodeHtmlEntities(value) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®',
  };
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hexadecimal = entity[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        try { return String.fromCodePoint(codePoint); } catch { return match; }
      }
      return match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function htmlToReadingText(html) {
  return decodeHtmlEntities(String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|math)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|main|header|footer|aside|h[1-6]|li|blockquote|pre|tr)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ''))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function flattenToc(items, rows = []) {
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    rows.push(item);
    flattenToc(item.children || item.subitems || item.items, rows);
  }
  return rows;
}

function cleanHref(value) {
  const raw = String(value || '').split('#')[0];
  try { return decodeURIComponent(raw).replace(/^\.\//, ''); }
  catch { return raw.replace(/^\.\//, ''); }
}

function epubChapterTitle(spineItem, tocRows, text, index) {
  const spineHref = cleanHref(spineItem?.href);
  const match = tocRows.find(item => {
    if (item?.id && spineItem?.id && String(item.id) === String(spineItem.id)) return true;
    const tocHref = cleanHref(item?.href || item?.url || item?.src);
    return Boolean(tocHref && spineHref && (tocHref === spineHref || tocHref.endsWith(`/${spineHref}`) || spineHref.endsWith(`/${tocHref}`)));
  });
  const tocTitle = String(match?.label || match?.title || match?.name || '').trim();
  if (tocTitle) return tocTitle.slice(0, 120);
  const firstLine = String(text || '').split('\n').map(line => line.trim()).find(Boolean) || '';
  if (firstLine && firstLine.length <= 80) return firstLine.slice(0, 120);
  return `第 ${index + 1} 章`;
}

async function extractDocx(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value || '' };
  } catch (error) {
    throw new Error(`Word 文档没有解析成功：${error.message || '文件可能已经损坏'}`);
  }
}

async function extractPdf(buffer) {
  const { PDFParse, PasswordException, InvalidPDFException } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText({ pageJoiner: '\n\n' });
    const text = String(result?.text || '').trim();
    if (!text) throw new Error('这份 PDF 没有可提取的文字，扫描版请先做 OCR 再上传。');
    return { text };
  } catch (error) {
    if (error instanceof PasswordException) throw new Error('这份 PDF 有密码保护，解锁后再上传。');
    if (error instanceof InvalidPDFException) throw new Error('这份 PDF 已损坏或格式不完整。');
    throw error;
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractEpub(buffer, { maxChapters = 2000, maxChars = 4_000_000 } = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ourhome-epub-'));
  let epub;
  try {
    const { initEpubFile } = await import('@lingo-reader/epub-parser');
    epub = await initEpubFile(new Uint8Array(buffer), tempDir);
    const metadata = epub.getMetadata?.() || {};
    const spine = (epub.getSpine?.() || []).filter(item => item?.linear !== 'no').slice(0, maxChapters);
    const tocRows = flattenToc(epub.getToc?.() || []);
    const chapters = [];
    let totalChars = 0;

    for (const spineItem of spine) {
      const loaded = await epub.loadChapter(spineItem.id);
      const content = htmlToReadingText(loaded?.html || '');
      if (!content) continue;
      totalChars += content.length;
      if (totalChars > maxChars) throw new Error('这本书太大了，先拆成几本再导入会更稳。');
      chapters.push({
        title: epubChapterTitle(spineItem, tocRows, content, chapters.length),
        content,
      });
    }

    if (!chapters.length) throw new Error('这个 EPUB 里没有读到正文，带 DRM 的电子书暂时无法导入。');
    return {
      title: String(metadata.title || '').trim(),
      chapters,
      text: chapters.map(chapter => chapter.content).join('\n\n'),
    };
  } catch (error) {
    if (/太大|没有读到正文/.test(String(error?.message || ''))) throw error;
    throw new Error(`EPUB 没有解析成功：${error.message || '文件可能带有 DRM 或已经损坏'}`);
  } finally {
    try { epub?.destroy?.(); } catch {}
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractReadingFile(file, options = {}) {
  if (!Buffer.isBuffer(file?.buffer)) throw new Error('没有收到可读取的文件。');
  const kind = detectReadingFileKind(file);
  if (!kind) throw new Error('支持 TXT、MD、DOCX、PDF 和 EPUB 文件。');
  if (kind === 'txt' || kind === 'md') return { kind, text: null };
  if (kind === 'docx') return { kind, ...await extractDocx(file.buffer) };
  if (kind === 'pdf') return { kind, ...await extractPdf(file.buffer) };
  return { kind, ...await extractEpub(file.buffer, options) };
}

module.exports = {
  detectReadingFileKind,
  htmlToReadingText,
  extractDocx,
  extractPdf,
  extractEpub,
  extractReadingFile,
};
