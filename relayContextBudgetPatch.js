'use strict';

const { isMainChatRequest } = require('./intimacyFlowSupport');

const previousFetch = globalThis.fetch;
const MAX_RELAY_CHAT_REQUEST_CHARS = 42_000;
const MIN_HISTORY_MESSAGES = 2;

function requestUrl(input) {
  return typeof input === 'string' || input instanceof URL
    ? String(input)
    : String(input?.url || '');
}

function requestPurpose(init = {}) {
  try {
    return String(new Headers(init.headers || undefined).get('X-OurHome-Call-Purpose') || '').trim();
  } catch {
    return '';
  }
}

function bodyTextLength(body = {}) {
  try {
    return JSON.stringify(body).length;
  } catch {
    return 0;
  }
}

function hasToolContinuation(body = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.some(message => {
    if (Array.isArray(message?.content)) {
      return message.content.some(block => block?.type === 'tool_use' || block?.type === 'tool_result');
    }
    return false;
  });
}

function trimOldHistory(body = {}) {
  if (!body || !Array.isArray(body.messages) || body.messages.length <= MIN_HISTORY_MESSAGES) return body;

  const originalChars = bodyTextLength(body);
  if (originalChars <= MAX_RELAY_CHAT_REQUEST_CHARS) return body;

  const messages = [...body.messages];
  let removed = 0;

  while (messages.length > MIN_HISTORY_MESSAGES && bodyTextLength({ ...body, messages }) > MAX_RELAY_CHAT_REQUEST_CHARS) {
    // Keep role ordering valid. Remove the oldest complete user/assistant pair.
    if (messages.length < 2) break;
    const first = messages[0];
    const second = messages[1];
    if ((first?.role === 'user' && second?.role === 'assistant')
      || (first?.role === 'assistant' && second?.role === 'user')) {
      messages.splice(0, 2);
      removed += 2;
      continue;
    }

    // Defensive fallback for unusual histories: remove only the oldest entry
    // when doing so cannot strand a tool continuation at the beginning.
    if (!hasToolContinuation({ messages: messages.slice(0, 2) })) {
      messages.shift();
      removed += 1;
      continue;
    }
    break;
  }

  const next = { ...body, messages };
  const nextChars = bodyTextLength(next);
  if (removed > 0) {
    console.warn(`[relay:context-cap] model=${body.model} chars=${originalChars}->${nextChars} removedMessages=${removed} cap=${MAX_RELAY_CHAT_REQUEST_CHARS}`);
  }
  return next;
}

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function relayContextBudgetFetch(input, init = {}) {
    const url = requestUrl(input);
    if (typeof init?.body !== 'string') return previousFetch(input, init);

    const purpose = requestPurpose(init);
    if (!/messages(?:\?|$)/i.test(url) || purpose !== 'chat') {
      return previousFetch(input, init);
    }

    try {
      const body = JSON.parse(init.body);
      if (!body?.model || !isMainChatRequest(url, body)) return previousFetch(input, init);
      const nextBody = trimOldHistory(body);
      if (nextBody !== body) {
        return previousFetch(input, { ...init, body: JSON.stringify(nextBody) });
      }
    } catch (error) {
      console.warn('[relay:context-cap] request patch skipped:', error.message);
    }

    return previousFetch(input, init);
  };
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function relayContextBudgetHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, relay_context_cap: '42k-request-chars-v1' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[relay:context-cap] health marker unavailable:', error.message);
}

module.exports = {
  MAX_RELAY_CHAT_REQUEST_CHARS,
  trimOldHistory,
};
