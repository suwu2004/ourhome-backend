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

function trimOldHistory(body = {}) {
  if (!body || !Array.isArray(body.messages) || body.messages.length <= MIN_HISTORY_MESSAGES) return body;

  const originalChars = bodyTextLength(body);
  if (originalChars <= MAX_RELAY_CHAT_REQUEST_CHARS) return body;

  const messages = [...body.messages];
  let protectedUserIndex = findProtectedUserIndex(messages);
  let removed = 0;

  while (
    protectedUserIndex > 0
    && messages.length > MIN_HISTORY_MESSAGES
    && bodyTextLength({ ...body, messages }) > MAX_RELAY_CHAT_REQUEST_CHARS
  ) {
    const first = messages[0];
    const second = messages[1];
    const pairIsNormal = (first?.role === 'user' && second?.role === 'assistant')
      || (first?.role === 'assistant' && second?.role === 'user');

    // Keep the last real user prompt even when newer tool_result messages are
    // present at the tail of a continuation request.
    if (pairIsNormal && protectedUserIndex >= 2 && !hasToolContinuation({ messages: messages.slice(0, 2) })) {
      messages.splice(0, 2);
      protectedUserIndex -= 2;
      removed += 2;
      continue;
    }

    if (protectedUserIndex >= 1 && !hasToolContinuation({ messages: messages.slice(0, 2) })) {
      messages.shift();
      protectedUserIndex -= 1;
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
