const USER_VISIBLE_SUMMARY_BLOCK_TYPES = new Set([
  'thinking_summary',
  'reasoning_summary',
  'summary_text',
  'thought_summary',
  'thoughts_summary',
]);
const USER_VISIBLE_SUMMARY_FIELD_NAMES = [
  'thinking_summary',
  'reasoning_summary',
  'summary_text',
  'thought_summary',
  'thoughts_summary',
];
const MAX_THINKING_CHARS = 24_000;
const MAX_VISIBLE_SUMMARY_CHARS = 1_600;
const BRACKETED_THINKING_LABEL = '(?:思考摘要|思考链|思考过程|思考记录|可见思考|想了想|thinking|reasoning|analysis)';
const BRACKETED_THINKING_PATTERNS = [
  new RegExp(`\\[\\s*${BRACKETED_THINKING_LABEL}\\s*[:：]\\s*([\\s\\S]*?)\\s*\\]`, 'gi'),
  new RegExp(`［\\s*${BRACKETED_THINKING_LABEL}\\s*[:：]\\s*([\\s\\S]*?)\\s*］`, 'gi'),
  new RegExp(`【\\s*${BRACKETED_THINKING_LABEL}\\s*[:：]\\s*([\\s\\S]*?)\\s*】`, 'gi'),
];

function normalizeThinkingText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim()
      .slice(0, MAX_THINKING_CHARS);
  }
  if (Array.isArray(value)) {
    return value
      .map(normalizeThinkingText)
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_THINKING_CHARS);
  }
  if (typeof value === 'object') {
    for (const key of [
      'reasoning_content',
      'reasoning',
      'reasoning_details',
      'thinking',
      'analysis',
      'thinking_summary',
      'reasoning_summary',
      'summary_text',
      'thought',
      'thoughts',
      'thought_summary',
      'thoughts_summary',
      'summary',
      'text',
      'content',
      'value',
    ]) {
      const raw = value[key];
      // `thought: true` / `is_thought: true` is a provider flag, not the actual thought text.
      if (typeof raw === 'boolean') continue;
      const text = normalizeThinkingText(raw);
      if (text) return text;
    }
  }
  return '';
}

function extractTaggedThinking(value) {
  const text = String(value || '');
  const results = [];
  const pattern = /<(thinking_summary|reasoning_summary|thought_summary|thoughts_summary)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of text.matchAll(pattern)) {
    const candidate = normalizeThinkingText(match[2]);
    if (candidate) results.push(candidate);
  }
  return results;
}

function extractBracketedThinking(value) {
  const text = String(value || '');
  const results = [];
  for (const pattern of BRACKETED_THINKING_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const candidate = normalizeThinkingText(match[1]);
      if (candidate) results.push(candidate);
    }
  }
  return results;
}

function extractVisibleSummaryMarkers(value) {
  const text = String(value || '');
  const results = [];
  const pattern = /【思考摘要开始】([\s\S]*?)【思考摘要结束】/g;
  for (const match of text.matchAll(pattern)) {
    const candidate = normalizeThinkingText(match[1]);
    if (candidate) results.push(candidate);
  }
  return results;
}

function stripThinkingMarkup(value) {
  let text = String(value || '')
    .replace(/<(thinking_summary|reasoning_summary|thinking|think|analysis)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(?:thinking_summary|reasoning_summary|thinking|think|analysis)\b[^>]*>/gi, '');
  for (const pattern of BRACKETED_THINKING_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, '');
  }
  text = text
    .replace(/【思考摘要开始】[\s\S]*?【思考摘要结束】/g, '')
    .replace(/【思考链开始】[\s\S]*?【思考链结束】/g, '')
    .replace(/【思考过程开始】[\s\S]*?【思考过程结束】/g, '');
  return text.replace(/^\s+/, '').trim();
}

function uniqueThinking(candidates) {
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = normalizeThinkingText(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique.join('\n').slice(0, MAX_THINKING_CHARS);
}

function hasChineseThinkingText(value) {
  const text = String(value || '');
  const chineseChars = (text.match(/[\\u3400-\\u9fff]/gu) || []).length;
  const latinChars = (text.match(/[A-Za-z]/gu) || []).length;
  return chineseChars >= 3 && chineseChars >= latinChars * 0.15;
}

function safeSummaryText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return normalizeThinkingText(value);
  if (Array.isArray(value)) return value.map(safeSummaryText).filter(Boolean).join('\\n');
  if (typeof value !== 'object') return '';

  for (const field of USER_VISIBLE_SUMMARY_FIELD_NAMES) {
    if (value[field] != null) {
      const nested = safeSummaryText(value[field]);
      if (nested) return nested;
    }
  }
  const type = String(value.type || '').toLowerCase();
  if (USER_VISIBLE_SUMMARY_BLOCK_TYPES.has(type)) {
    if (typeof value.text === 'string') return normalizeThinkingText(value.text);
    if (typeof value.content === 'string') return normalizeThinkingText(value.content);
    if (Array.isArray(value.summary)) return safeSummaryText(value.summary);
  }
  return '';
}

function extractThinkingText(result = {}) {
  const providerSummaryCandidates = [];
  const taggedCandidates = [];
  const visibleSummaryCandidates = [];
  const addSummary = value => {
    const text = safeSummaryText(value);
    if (text) providerSummaryCandidates.push(text);
  };
  const addTagged = value => {
    const tagged = extractTaggedThinking(value);
    if (tagged.length) taggedCandidates.push(...tagged);
    const visible = extractVisibleSummaryMarkers(value);
    if (visible.length) visibleSummaryCandidates.push(...visible);
  };
  const addSummaryFields = value => {
    if (!value || typeof value !== 'object') return;
    for (const field of USER_VISIBLE_SUMMARY_FIELD_NAMES) {
      if (value[field] != null) addSummary(value[field]);
    }
  };
  const scanBlocks = blocks => {
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (!block || typeof block !== 'object') continue;
      const type = String(block.type || '').toLowerCase();
      // Raw reasoning_content, analysis, thinking blocks and thought=true parts are private.
      if (USER_VISIBLE_SUMMARY_BLOCK_TYPES.has(type)) addSummary(block);
      for (const field of USER_VISIBLE_SUMMARY_FIELD_NAMES) {
        if (block[field] != null) addSummary(block[field]);
      }
      // Responses APIs may wrap a safe summary_text block inside a raw reasoning envelope.
      // Walk only its summary member, never its raw content.
      if (type === 'reasoning' && Array.isArray(block.summary)) scanBlocks(block.summary);
      if (type === 'text' || type === 'output_text') {
        const visible = extractVisibleSummaryMarkers(block.text);
        if (visible.length) visibleSummaryCandidates.push(...visible);
      }
      if (Array.isArray(block.content)) scanBlocks(block.content);
      if (Array.isArray(block.parts)) scanBlocks(block.parts);
    }
  };

  addSummaryFields(result);
  addSummaryFields(result.message);
  addTagged(result.content);
  addTagged(result.message?.content);
  scanBlocks(result.content);
  scanBlocks(result.message?.content);
  scanBlocks(result.output);

  for (const choice of Array.isArray(result.choices) ? result.choices : []) {
    const message = choice?.message || choice?.delta || {};
    addSummaryFields(choice);
    addSummaryFields(message);
    addTagged(choice?.text);
    addTagged(message.content);
    scanBlocks(message.content);
  }
  for (const candidate of Array.isArray(result.candidates) ? result.candidates : []) {
    addSummaryFields(candidate);
    addSummaryFields(candidate?.content);
    addTagged(candidate?.text);
    addTagged(candidate?.content);
    scanBlocks(candidate?.content?.parts);
  }

  // Only marked user-facing summaries may enter the UI; raw native reasoning stays private.
  const summary = uniqueThinking([
    ...visibleSummaryCandidates,
    ...providerSummaryCandidates,
    ...taggedCandidates,
  ]).slice(0, MAX_VISIBLE_SUMMARY_CHARS);
  return hasChineseThinkingText(summary) ? summary : '';
}

module.exports = {
  MAX_THINKING_CHARS,
  normalizeThinkingText,
  extractTaggedThinking,
  extractBracketedThinking,
  extractVisibleSummaryMarkers,
  stripThinkingMarkup,
  extractThinkingText,
};
