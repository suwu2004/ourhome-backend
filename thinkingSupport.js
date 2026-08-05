const THINKING_BLOCK_TYPES = new Set(['thinking', 'reasoning', 'analysis']);
const THINKING_FIELD_NAMES = ['reasoning_content', 'reasoning', 'thinking', 'analysis'];
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
    return value.map(normalizeThinkingText).filter(Boolean).join('\n').slice(0, MAX_THINKING_CHARS);
  }
  if (typeof value === 'object') {
    for (const key of ['thinking', 'reasoning_content', 'reasoning', 'analysis', 'text', 'content']) {
      const text = normalizeThinkingText(value[key]);
      if (text) return text;
    }
  }
  return '';
}

function extractTaggedThinking(value) {
  const text = String(value || '');
  const results = [];
  const pattern = /<(thinking|think|analysis)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of text.matchAll(pattern)) {
    const candidate = normalizeThinkingText(match[2]);
    if (candidate) results.push(candidate);
  }
  return results;
}

function stripThinkingMarkup(value) {
  return String(value || '')
    .replace(/<(thinking|think|analysis)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(?:thinking|think|analysis)\b[^>]*>/gi, '')
    .trim();
}

function extractThinkingText(result = {}) {
  const candidates = [];
  const add = value => {
    const text = normalizeThinkingText(value);
    if (text) candidates.push(text);
  };

  for (const field of THINKING_FIELD_NAMES) add(result?.[field]);
  for (const field of THINKING_FIELD_NAMES) add(result?.message?.[field]);

  const contentBlocks = Array.isArray(result?.content) ? result.content : [];
  for (const block of contentBlocks) {
    const type = String(block?.type || '').toLowerCase();
    if (THINKING_BLOCK_TYPES.has(type)) add(block);
    if (type === 'text') candidates.push(...extractTaggedThinking(block?.text));
  }

  if (typeof result?.content === 'string') {
    candidates.push(...extractTaggedThinking(result.content));
  }

  for (const choice of Array.isArray(result?.choices) ? result.choices : []) {
    const message = choice?.message || choice?.delta || {};
    for (const field of THINKING_FIELD_NAMES) add(message?.[field]);
    if (typeof message?.content === 'string') candidates.push(...extractTaggedThinking(message.content));
  }

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

module.exports = {
  MAX_THINKING_CHARS,
  normalizeThinkingText,
  extractTaggedThinking,
  stripThinkingMarkup,
  extractThinkingText,
};
