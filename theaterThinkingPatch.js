'use strict';

// Bring formal Chat's native-thinking transport into Theater without changing
// the Theater visual shell or inventing a second paid "thinking" completion.
const previousFetch = globalThis.fetch;
const express = require('express');
const { extractThinkingText } = require('./thinkingSupport');

const THEATER_RE = /OurHome 的[“"]小剧场[”](?:长文|互动)写作引擎/u;
const SUPABASE_LETTERS_RE = /\/rest\/v1\/letters(?:\?|$)/i;
const THEATER_MESSAGE_CATEGORY = '小剧场';
const reasoningByContent = new Map();
const MAX_CACHE = 1200;

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('\n');
}
function isTheaterProviderBody(body) {
  return Array.isArray(body?.messages) && body.messages.length > 0 && THEATER_RE.test(textOf(body.system));
}
function modelSupportsNativeThinking(model) {
  return /thinking|reasoning|opus-4-6|sonnet-4-6|haiku-4-5/i.test(String(model || ''));
}
function remember(content, thinking) {
  const key = String(content || '').trim();
  const value = String(thinking || '').trim();
  if (!key || !value) return;
  reasoningByContent.delete(key);
  reasoningByContent.set(key, value);
  while (reasoningByContent.size > MAX_CACHE) reasoningByContent.delete(reasoningByContent.keys().next().value);
}
function lookup(content) { return reasoningByContent.get(String(content || '').trim()) || ''; }
function maybeEnableThinking(body) {
  if (!isTheaterProviderBody(body) || body.thinking || !modelSupportsNativeThinking(body.model)) return body;
  return { ...body, thinking: { type: 'enabled', budget_tokens: 3000 } };
}
function isTheaterAssistantInsert(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return body.category === THEATER_MESSAGE_CATEGORY && body.author === '泽' && typeof body.content === 'string';
}
function enrichResponseBody(body) {
  if (Array.isArray(body)) {
    return body.map(item => item?.messages ? {
      ...item,
      messages: item.messages.map(message => message?.role === 'assistant'
        ? { ...message, reasoning_content: message.reasoning_content || lookup(message.content) || null }
        : message),
    } : item);
  }
  if (body?.assistant_message) {
    const thinking = body.assistant_message.reasoning_content || lookup(body.assistant_message.content) || null;
    return thinking ? { ...body, assistant_message: { ...body.assistant_message, reasoning_content: thinking } } : body;
  }
  return body;
}
function cacheLettersPayload(payload) {
  const rows = Array.isArray(payload) ? payload : (payload && typeof payload === 'object' ? [payload] : []);
  rows.forEach(row => {
    if (row?.author === '泽' && row?.reasoning_content) remember(row.content, row.reasoning_content);
  });
}
function cacheProviderPayload(payload) {
  const thinking = extractThinkingText(payload);
  if (!thinking) return;
  const texts = [];
  const collect = value => {
    if (value == null) return;
    if (typeof value === 'string') { texts.push(value); return; }
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (typeof value === 'object') {
      if (typeof value.text === 'string') texts.push(value.text);
      collect(value.content);
      collect(value.message?.content);
      collect(value.choices);
      collect(value.output);
    }
  };
  collect(payload);
  const answer = texts.find(text => text.trim() && text.trim() !== thinking.trim()) || '';
  if (answer) remember(answer, thinking);
}

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function theaterThinkingFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url || '';
    if (typeof init?.body !== 'string') {
      const response = await previousFetch(input, init);
      if (SUPABASE_LETTERS_RE.test(url) && (!init?.method || String(init.method).toUpperCase() === 'GET')) {
        response.clone().json().then(cacheLettersPayload).catch(() => {});
      }
      return response;
    }
    try {
      const body = JSON.parse(init.body);
      if (SUPABASE_LETTERS_RE.test(url) && isTheaterAssistantInsert(body)) {
        const thinking = lookup(body.content);
        if (thinking) body.reasoning_content = thinking;
      }
      const prepared = isTheaterProviderBody(body) ? maybeEnableThinking(body) : body;
      const response = await previousFetch(input, prepared === body ? init : { ...init, body: JSON.stringify(prepared) });
      if (isTheaterProviderBody(prepared)) {
        try {
          const payload = await response.clone().json();
          cacheProviderPayload(payload);
        } catch {
          // Some relays return non-JSON errors; the original response still flows through unchanged.
        }
      }
      return response;
    } catch (error) {
      console.warn('[theater:thinking] skipped:', error.message);
      return previousFetch(input, init);
    }
  };
}

try {
  const originalJson = express.response.json;
  express.response.json = function theaterThinkingJson(body) {
    return originalJson.call(this, enrichResponseBody(body));
  };
} catch (error) {
  console.warn('[theater:thinking] response hook unavailable:', error.message);
}

module.exports = { THEATER_RE, modelSupportsNativeThinking, maybeEnableThinking, remember, lookup, enrichResponseBody, cacheLettersPayload, cacheProviderPayload };
