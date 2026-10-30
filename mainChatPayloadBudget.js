'use strict';

const MAX_MAIN_CHAT_PAYLOAD_CHARS = 38_000;
const MIN_HISTORY_MESSAGES = 2;

function serializedLength(body = {}) {
  try {
    return JSON.stringify(body).length;
  } catch {
    return 0;
  }
}

function hasToolContinuation(messages = []) {
  return (Array.isArray(messages) ? messages : []).some(message => (
    Array.isArray(message?.content)
      && message.content.some(block => block?.type === 'tool_use' || block?.type === 'tool_result')
  ));
}

function isMeaningfulUserMessage(message = {}) {
  if (message?.role !== 'user') return false;
  const content = message.content;
  if (typeof content === 'string') return Boolean(content.trim());
  if (!Array.isArray(content)) return Boolean(String(content || '').trim());
  return content.some(block => {
    if (!block || block.type === 'tool_result') return false;
    if (block.type === 'text') return Boolean(String(block.text || '').trim());
    return block.type === 'image' || block.type === 'document'
      || Boolean(block.source || block.data || block.url);
  });
}

function findProtectedUserIndex(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (isMeaningfulUserMessage(list[index])) return index;
  }
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === 'user') return index;
  }
  return Math.max(0, list.length - MIN_HISTORY_MESSAGES);
}

// This runs after the hidden continuity ledger has been injected. The older
// relay cap runs before that injection, so it cannot bound the final payload.
function trimOldHistory(body = {}, maxChars = MAX_MAIN_CHAT_PAYLOAD_CHARS) {
  if (!body || !Array.isArray(body.messages) || body.messages.length <= MIN_HISTORY_MESSAGES) return body;
  const originalChars = serializedLength(body);
  const cap = Math.max(8_000, Number(maxChars) || MAX_MAIN_CHAT_PAYLOAD_CHARS);
  if (originalChars <= cap) return body;

  const messages = [...body.messages];
  let protectedUserIndex = findProtectedUserIndex(messages);
  let removed = 0;
  while (
    protectedUserIndex > 0
    && messages.length > MIN_HISTORY_MESSAGES
    && serializedLength({ ...body, messages }) > cap
  ) {
    const first = messages[0];
    const second = messages[1];
    const pairIsNormal = (first?.role === 'user' && second?.role === 'assistant')
      || (first?.role === 'assistant' && second?.role === 'user');

    // The latest human message is the anchor for the current turn. During a
    // tool loop, assistant tool_use + user tool_result messages are appended
    // after it; those tool messages must never make the real prompt look old.
    if (pairIsNormal && protectedUserIndex >= 2 && !hasToolContinuation(messages.slice(0, 2))) {
      messages.splice(0, 2);
      protectedUserIndex -= 2;
      removed += 2;
      continue;
    }

    if (protectedUserIndex >= 1 && !hasToolContinuation(messages.slice(0, 2))) {
      messages.shift();
      protectedUserIndex -= 1;
      removed += 1;
      continue;
    }
    break;
  }

  if (removed === 0) return body;
  const next = { ...body, messages };
  const nextChars = serializedLength(next);
  console.warn(
    `[chat:final-budget] chars=${originalChars}->${nextChars} removedMessages=${removed} cap=${cap}`,
  );
  if (nextChars > cap) {
    console.warn(`[chat:final-budget] fixed payload remains over cap by ${nextChars - cap} chars; kept system/tools/current turn intact`);
  }
  return next;
}

module.exports = {
  MAX_MAIN_CHAT_PAYLOAD_CHARS,
  serializedLength,
  hasToolContinuation,
  isMeaningfulUserMessage,
  findProtectedUserIndex,
  trimOldHistory,
};
