'use strict';

// Compatibility shell for older code paths. Synthetic visible thinking is retired.
// These exports remain so a stale import cannot crash the service, but none of them
// can create a provider request, invent a thought, or inject fake reasoning metadata.
const MAX_THOUGHT_CHARS = 12_000;

function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string' || typeof content === 'number') return String(content);
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block;
        if (!block || typeof block !== 'object') return '';
        if (typeof block.text === 'string') return block.text;
        if (typeof block.content === 'string') return block.content;
        if (block.type === 'image' || block.type === 'image_url') return '[图片]';
        if (block.type === 'tool_result') return contentText(block.content);
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') return contentText(content.text || content.content || content.value || '');
  return '';
}

function extractResponseText(result = {}) {
  if (typeof result?.content === 'string') return result.content;
  if (Array.isArray(result?.content)) {
    const text = result.content
      .filter(block => !block?.type || block.type === 'text' || block.type === 'output_text')
      .map(block => contentText(block))
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  for (const choice of Array.isArray(result?.choices) ? result.choices : []) {
    const text = contentText(choice?.message?.content || choice?.delta?.content || choice?.text);
    if (text) return text;
  }
  return contentText(result?.text || result?.output_text || result?.message?.content);
}

function normalizeVisibleThought() {
  return '';
}

function recentConversationText() {
  return '';
}

function buildFallbackPrompt() {
  return '';
}

function buildFallbackRequestBody() {
  return null;
}

function deterministicFallbackThought() {
  return '';
}

function injectReasoningContent(result = {}) {
  return result;
}

module.exports = {
  MAX_THOUGHT_CHARS,
  contentText,
  extractResponseText,
  normalizeVisibleThought,
  recentConversationText,
  buildFallbackPrompt,
  buildFallbackRequestBody,
  deterministicFallbackThought,
  injectReasoningContent,
};
