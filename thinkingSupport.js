const SUMMARY_BLOCK_TYPES = new Set(['thinking_summary', 'reasoning_summary', 'summary']);
const SUMMARY_FIELD_NAMES = ['thinking_summary', 'reasoning_summary', 'summary_text'];
const MAX_THINKING_CHARS = 4_000;

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
    for (const key of ['thinking_summary', 'reasoning_summary', 'summary_text', 'summary', 'text', 'content']) {
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

function extractThinkingText(result = {}) {
  const candidates = [];
  const add = value => {
    const text = normalizeThinkingText(value);
    if (text) candidates.push(text);
  };

  // 只读取明确标记为“摘要”的字段。reasoning_content / thinking / analysis
  // 可能包含模型的完整内部推理，不作为可见聊天内容保存或展示。
  for (const field of SUMMARY_FIELD_NAMES) add(result?.[field]);
  for (const field of SUMMARY_FIELD_NAMES) add(result?.message?.[field]);

  const contentBlocks = Array.isArray(result?.content) ? result.content : [];
  for (const block of contentBlocks) {
    const type = String(block?.type || '').toLowerCase();
    if (SUMMARY_BLOCK_TYPES.has(type)) add(block);
    if (type === 'text') candidates.push(...extractTaggedThinking(block?.text));
  }

  if (typeof result?.content === 'string') {
    candidates.push(...extractTaggedThinking(result.content));
  }

  for (const choice of Array.isArray(result?.choices) ? result.choices : []) {
    const message = choice?.message || choice?.delta || {};
    for (const field of SUMMARY_FIELD_NAMES) add(message?.[field]);
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
