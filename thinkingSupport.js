const NATIVE_THINKING_BLOCK_TYPES = new Set([
  'thinking',
  'reasoning',
  'analysis',
  'thinking_summary',
  'reasoning_summary',
]);
const NATIVE_THINKING_FIELD_NAMES = [
  'reasoning_content',
  'reasoning',
  'reasoning_details',
  'thinking',
  'analysis',
  'thinking_summary',
  'reasoning_summary',
  'summary_text',
];
const MAX_THINKING_CHARS = 24_000;
const BRACKETED_THINKING_LABEL = '(?:思考链|思考过程|思考记录|可见思考|想了想|thinking|reasoning|analysis)';
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
      'summary',
      'text',
      'content',
      'value',
    ]) {
      const text = normalizeThinkingText(value[key]);
      if (text) return text;
    }
  }
  return '';
}

function extractTaggedThinking(value) {
  const text = String(value || '');
  const results = [];
  const pattern = /<(thinking_summary|reasoning_summary|thinking|think|analysis)\b[^>]*>([\s\S]*?)<\/\1>/gi;
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

function stripThinkingMarkup(value) {
  let text = String(value || '')
    .replace(/<(thinking_summary|reasoning_summary|thinking|think|analysis)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(?:thinking_summary|reasoning_summary|thinking|think|analysis)\b[^>]*>/gi, '');
  for (const pattern of BRACKETED_THINKING_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, '');
  }
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

function extractThinkingText(result = {}) {
  const nativeCandidates = [];
  const addNative = value => {
    const text = normalizeThinkingText(value);
    if (text) nativeCandidates.push(text);
  };
  const addNativeFields = value => {
    if (!value || typeof value !== 'object') return;
    for (const field of NATIVE_THINKING_FIELD_NAMES) addNative(value[field]);
  };
  const scanBlocks = blocks => {
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (!block || typeof block !== 'object') continue;
      const type = String(block.type || '').toLowerCase();
      if (NATIVE_THINKING_BLOCK_TYPES.has(type) || block.thought === true) addNative(block);
      if (Array.isArray(block.content)) scanBlocks(block.content);
      if (Array.isArray(block.parts)) scanBlocks(block.parts);
      if (Array.isArray(block.summary) && NATIVE_THINKING_BLOCK_TYPES.has(type)) addNative(block.summary);
    }
  };

  addNativeFields(result);
  addNativeFields(result.message);
  scanBlocks(result.content);
  scanBlocks(result.message?.content);
  scanBlocks(result.output);

  for (const choice of Array.isArray(result.choices) ? result.choices : []) {
    const message = choice?.message || choice?.delta || {};
    addNativeFields(choice);
    addNativeFields(message);
    scanBlocks(message.content);
  }

  for (const candidate of Array.isArray(result.candidates) ? result.candidates : []) {
    addNativeFields(candidate);
    addNativeFields(candidate?.content);
    scanBlocks(candidate?.content?.parts);
  }

  // Native-only rule: ordinary answer text, <thinking> tags and bracketed
  // “visible thought” prose are never promoted into the thinking panel.
  // If the provider does not return explicit reasoning/thinking metadata, this is empty.
  return uniqueThinking(nativeCandidates);
}

module.exports = {
  MAX_THINKING_CHARS,
  normalizeThinkingText,
  extractTaggedThinking,
  extractBracketedThinking,
  stripThinkingMarkup,
  extractThinkingText,
};
