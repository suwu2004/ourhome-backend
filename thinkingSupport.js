const NATIVE_THINKING_BLOCK_TYPES = new Set([
  'thinking',
  'reasoning',
  'analysis',
  'thinking_summary',
  'reasoning_summary',
  'summary',
]);
const NATIVE_THINKING_FIELD_NAMES = [
  'reasoning_content',
  'reasoning',
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
      'thinking',
      'analysis',
      'thinking_summary',
      'reasoning_summary',
      'summary_text',
      'summary',
      'text',
      'content',
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

function collectVisibleThinking(value, target) {
  target.push(...extractTaggedThinking(value));
  target.push(...extractBracketedThinking(value));
}

function extractThinkingText(result = {}) {
  const nativeCandidates = [];
  const simulatedCandidates = [];
  const addNative = value => {
    const text = normalizeThinkingText(value);
    if (text) nativeCandidates.push(text);
  };

  for (const field of NATIVE_THINKING_FIELD_NAMES) addNative(result?.[field]);
  for (const field of NATIVE_THINKING_FIELD_NAMES) addNative(result?.message?.[field]);

  const contentBlocks = Array.isArray(result?.content) ? result.content : [];
  for (const block of contentBlocks) {
    const type = String(block?.type || '').toLowerCase();
    if (NATIVE_THINKING_BLOCK_TYPES.has(type)) addNative(block);
    if (type === 'text' || type === 'output_text' || !type) collectVisibleThinking(block?.text || block?.content, simulatedCandidates);
  }

  if (typeof result?.content === 'string') collectVisibleThinking(result.content, simulatedCandidates);
  collectVisibleThinking(result?.text || result?.output_text, simulatedCandidates);

  for (const choice of Array.isArray(result?.choices) ? result.choices : []) {
    const message = choice?.message || choice?.delta || {};
    for (const field of NATIVE_THINKING_FIELD_NAMES) addNative(message?.[field]);
    collectVisibleThinking(message?.content || choice?.text, simulatedCandidates);
  }

  // 模型或中转站明确返回原生 reasoning/thinking 时，完整展示它；
  // 只有原生思考为空时，才退回模型在正文里生成的可见思考标记。
  return uniqueThinking(nativeCandidates) || uniqueThinking(simulatedCandidates);
}

module.exports = {
  MAX_THINKING_CHARS,
  normalizeThinkingText,
  extractTaggedThinking,
  extractBracketedThinking,
  stripThinkingMarkup,
  extractThinkingText,
};
