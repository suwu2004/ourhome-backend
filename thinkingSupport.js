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

function stripThinkingMarkup(value) {
  return String(value || '')
    .replace(/<(thinking_summary|reasoning_summary|thinking|think|analysis)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(?:thinking_summary|reasoning_summary|thinking|think|analysis)\b[^>]*>/gi, '')
    .trim();
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
    if (type === 'text') simulatedCandidates.push(...extractTaggedThinking(block?.text));
  }

  if (typeof result?.content === 'string') {
    simulatedCandidates.push(...extractTaggedThinking(result.content));
  }

  for (const choice of Array.isArray(result?.choices) ? result.choices : []) {
    const message = choice?.message || choice?.delta || {};
    for (const field of NATIVE_THINKING_FIELD_NAMES) addNative(message?.[field]);
    if (typeof message?.content === 'string') {
      simulatedCandidates.push(...extractTaggedThinking(message.content));
    }
  }

  // 模型或中转站明确返回原生 reasoning/thinking 时，完整展示它；
  // 只有原生思考为空时，才退回模型在正文里生成的 <thinking> 可见思考。
  return uniqueThinking(nativeCandidates) || uniqueThinking(simulatedCandidates);
}

module.exports = {
  MAX_THINKING_CHARS,
  normalizeThinkingText,
  extractTaggedThinking,
  stripThinkingMarkup,
  extractThinkingText,
};
