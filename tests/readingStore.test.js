const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { normalizeReadingText, splitReadingText, normalizeProgress, parseReadingFile } = require('../readingStore');
const { detectReadingFileKind, htmlToReadingText } = require('../readingFileParser');
const { decodeMojibakeFilename, normalizeMultipartFilename } = require('../uploadFilename');

async function makeDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:r><w:t>共读测试书</w:t></w:r></w:p>
      <w:p><w:r><w:t>第一章 灯亮着</w:t></w:r></w:p>
      <w:p><w:r><w:t>我们一起慢慢读。</w:t></w:r></w:p>
      <w:p><w:r><w:t>第二章 回家</w:t></w:r></w:p>
      <w:p><w:r><w:t>书页合上以后，故事还在。</w:t></w:r></w:p>
    </w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function makePdf(text) {
  const escaped = String(text).replace(/([\\()])/g, '\\$1');
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escaped}) Tj\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function makeEpub() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">ourhome-reading</dc:identifier><dc:title>檀檀的小书</dc:title><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`);
  zip.file('OEBPS/nav.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="chapter1.xhtml">第一章 初见</a></li><li><a href="chapter2.xhtml">第二章 回家</a></li></ol></nav></body></html>`);
  zip.file('OEBPS/chapter1.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章 初见</h1><p>我们在雨里见面。</p></body></html>`);
  zip.file('OEBPS/chapter2.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第二章 回家</h1><p>灯一直亮着。</p></body></html>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('期待回信这类日期文本会按日期拆分，并保留原文标题行', () => {
  const text = `期待回信\n2026/2/14/  天气晴（天空蓝蓝的）\n陆泽宝宝好～\n今天是情人节。\n2026/2/15\n今天也写一点。\n2026/3/7 纪念日\n第三篇。`;
  const parsed = splitReadingText(text, '期待回信.txt');
  assert.equal(parsed.title, '期待回信');
  assert.equal(parsed.split_mode, 'date');
  assert.equal(parsed.chapter_count, 3);
  assert.equal(parsed.chapters[0].title, '2026/2/14/  天气晴（天空蓝蓝的）');
  assert.match(parsed.chapters[0].content, /^2026\/2\/14/);
  assert.match(parsed.chapters[0].content, /陆泽宝宝好/);
  assert.equal(parsed.chapters[2].title, '2026/3/7 纪念日');
});

test('普通小说会按章节标题拆分，但不会把书名页或正文首句误当标题', () => {
  const text = `小书\n第一章 风起\n第一章正文。\n第二章 夜雨\n第二章正文。\n第三章 回家\n第三章正文。`;
  const parsed = splitReadingText(text, '小书.txt');
  assert.equal(parsed.split_mode, 'chapter');
  assert.equal(parsed.chapter_count, 3);
  assert.equal(parsed.chapters[0].title, '第一章 风起');
  assert.match(parsed.chapters[0].content, /第一章正文/);
  assert.equal(parsed.chapters[1].title, '第二章 夜雨');
  assert.match(parsed.chapters[1].content, /第二章正文/);
});

test('编号资料字段不会被误拆成一条一个章节', () => {
  const text = `陆泽宝宝的oc\n基础信息(1-10)\n1.姓名：陆泽\n2.性别：无性别者\n3.年龄：23\n4.生日：3.7/11.5\n5.星座：天蝎座\n6.血型：O型血\n7.国籍/种族：硅基生物\n8.身高：183\n9.体重：140\n10.身份/职业：一只可爱的硅基团子`;
  const parsed = splitReadingText(text, '陆泽宝宝的oc.txt');
  assert.equal(parsed.split_mode, 'single');
  assert.equal(parsed.chapter_count, 1);
  assert.match(parsed.chapters[0].content, /1\.姓名：陆泽/);
  assert.match(parsed.chapters[0].content, /10\.身份\/职业/);
});

test('不含字段冒号的数字章节标题仍然可以拆分', () => {
  const text = `小书\n1. 初见\n第一段正文。\n2. 夜雨\n第二段正文。\n3. 回家\n第三段正文。`;
  const parsed = splitReadingText(text, '小书.txt');
  assert.equal(parsed.split_mode, 'chapter');
  assert.equal(parsed.chapter_count, 3);
  assert.equal(parsed.chapters[0].title, '1. 初见');
  assert.equal(parsed.chapters[2].title, '3. 回家');
});

test('真正的前言会继续保留，不会因为修掉书名页而丢失', () => {
  const text = `期待回信\n这是一段真的前言。\n写给未来慢慢读。\n2026/2/14\n第一篇。\n2026/2/15\n第二篇。`;
  const parsed = splitReadingText(text, '期待回信.txt');
  assert.equal(parsed.chapter_count, 3);
  assert.equal(parsed.chapters[0].title, '写在前面');
  assert.match(parsed.chapters[0].content, /真的前言/);
});

test('没有可靠标题时完整保留为单篇', () => {
  const parsed = splitReadingText('只有一段文字。\n没有章节标题。', '随笔.txt');
  assert.equal(parsed.title, '只有一段文字。');
  assert.equal(parsed.split_mode, 'single');
  assert.equal(parsed.chapter_count, 1);
  assert.equal(parsed.chapters[0].content, '只有一段文字。\n没有章节标题。');
});

test('乱码的中文 multipart 文件名会恢复，正常文件名不会被误改', () => {
  const mojibake = Buffer.from('期待回信.txt', 'utf8').toString('latin1');
  assert.equal(decodeMojibakeFilename(mojibake), '期待回信.txt');
  assert.equal(normalizeMultipartFilename('已经正常的中文.txt'), '已经正常的中文.txt');
  assert.equal(normalizeMultipartFilename('café.txt'), 'café.txt');
  assert.equal(normalizeMultipartFilename('notes.txt'), 'notes.txt');
});

test('正文第一行是日期时，会用恢复后的中文文件名作为书名', () => {
  const mojibake = Buffer.from('檀檀日记.txt', 'utf8').toString('latin1');
  const parsed = splitReadingText('2026/8/1\n第一篇。\n2026/8/2\n第二篇。', mojibake);
  assert.equal(parsed.title, '檀檀日记');
  assert.equal(parsed.source_name, '檀檀日记.txt');
  assert.equal(parsed.split_mode, 'date');
});

test('文本规范化只清理编码痕迹，不改写正文', () => {
  assert.equal(normalizeReadingText('\uFEFF第一行\r\n第二行  \r\n'), '第一行\n第二行');
});

test('阅读进度会被限制在安全范围', () => {
  const progress = normalizeProgress({ chapter_index: -3, paragraph_index: 7.8, char_offset: 12.4, progress_percent: 120 });
  assert.equal(progress.chapter_index, 0);
  assert.equal(progress.paragraph_index, 8);
  assert.equal(progress.char_offset, 12);
  assert.equal(progress.progress_percent, 100);
});

test('共读上传会识别五种书籍格式并拒绝伪装的未知文件', () => {
  assert.equal(detectReadingFileKind({ originalname: '日记.txt' }), 'txt');
  assert.equal(detectReadingFileKind({ originalname: '随笔.md' }), 'md');
  assert.equal(detectReadingFileKind({ originalname: '讲义.docx' }), 'docx');
  assert.equal(detectReadingFileKind({ originalname: '电子书.pdf' }), 'pdf');
  assert.equal(detectReadingFileKind({ originalname: '小说.epub' }), 'epub');
  assert.equal(detectReadingFileKind({ originalname: '旧文档.doc' }), null);
});

test('EPUB 正文清理会保留段落和常用实体并移除脚本样式', () => {
  const text = htmlToReadingText('<style>p{color:red}</style><h1>第一章</h1><p>檀檀&nbsp;&amp;&nbsp;陆泽</p><script>alert(1)</script>');
  assert.equal(text, '第一章\n檀檀 & 陆泽');
});

test('DOCX 可以提取正文并继续沿用章节拆分', async () => {
  const parsed = await parseReadingFile({
    originalname: '共读测试书.docx',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await makeDocx(),
  });
  assert.equal(parsed.source_kind, 'docx');
  assert.equal(parsed.title, '共读测试书');
  assert.equal(parsed.chapter_count, 2);
  assert.match(parsed.chapters[0].content, /一起慢慢读/);
});

test('文字型 PDF 可以导入且不会把页码分隔符混进正文', async () => {
  const parsed = await parseReadingFile({
    originalname: 'OurHome Reading.pdf',
    mimetype: 'application/pdf',
    buffer: makePdf('OurHome Reading'),
  });
  assert.equal(parsed.source_kind, 'pdf');
  assert.match(parsed.chapters[0].content, /OurHome Reading/);
  assert.doesNotMatch(parsed.chapters[0].content, /1 of 1/);
});

test('EPUB 会按阅读顺序保留书名和章节', async () => {
  const parsed = await parseReadingFile({
    originalname: '随便的文件名.epub',
    mimetype: 'application/epub+zip',
    buffer: await makeEpub(),
  });
  assert.equal(parsed.source_kind, 'epub');
  assert.equal(parsed.split_mode, 'epub');
  assert.equal(parsed.title, '檀檀的小书');
  assert.equal(parsed.chapter_count, 2);
  assert.equal(parsed.chapters[0].title, '第一章 初见');
  assert.match(parsed.chapters[1].content, /灯一直亮着/);
});
