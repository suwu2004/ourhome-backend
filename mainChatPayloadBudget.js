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

// This runs after the hidden continuity ledger has been injected. The older
// relay cap runs before that injection, so it cannot bound the final payload.
function trimOldHistory(body = {}, maxChars = MAX_MAIN_CHAT_PAYLOAD_CHARS) {
  if (!body || !Array.isArray(body.messages) || body.messages.length <= MIN_HISTORY_MESSAGES) return body;
  const originalChars = serializedLength(body);
  const cap = Math.max(8_000, Number(maxChars) || MAX_MAIN_CHAT_PAYLOAD_CHARS);
  if (originalChars <= cap) return body;

  const messages = [...body.messages];
  let removed = 0;
  while (messages.length > MIN_HISTORY_MESSAGES && serializedLength({ ...body, messages }) > cap) {
    const first = messages[0];
    const second = messages[1];
    const pairIsNormal = (first?.role === 'user' && second?.role === 'assistant')
      || (first?.role === 'assistant' && second?.role === 'user');

    if (pairIsNormal && !hasToolContinuation(messages.slice(0, 2))) {
      messages.splice(0, 2);
      removed += 2;
      continue;
    }

    if (!hasToolContinuation(messages.slice(0, 2))) {
      messages.shift();
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
  trimOldHistory,
};
