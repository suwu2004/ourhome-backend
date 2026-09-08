'use strict';

// Final provider-boundary guard. The earlier raw-turn layer creates the
// authoritative live transcript; this guard must use the same 30-message
// ceiling so it cannot silently throw away half of the context again.
const previousFetch = globalThis.fetch;
const THEATER_RE = /OurHome 的[“"]小剧场[”](?:长文|互动)写作引擎/u;
const RECENT_MESSAGE_WINDOW = 30;

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('\n');
}
function isTheaterBody(body) { return Array.isArray(body?.messages) && body.messages.length > 0 && THEATER_RE.test(textOf(body.system)); }
function trimToRecentTheaterWindow(body) {
  if (!isTheaterBody(body) || body.messages.length <= RECENT_MESSAGE_WINDOW) return body;
  let messages = body.messages.slice(-RECENT_MESSAGE_WINDOW);
  if (messages[0]?.role === 'assistant') messages = messages.slice(1);
  return { ...body, messages };
}
if (typeof previousFetch === 'function') {
  globalThis.fetch = async function theaterContextWindowFetch(input, init = {}) {
    if (typeof init?.body !== 'string') return previousFetch(input, init);
    try {
      const body = JSON.parse(init.body);
      const trimmed = trimToRecentTheaterWindow(body);
      return previousFetch(input, trimmed === body ? init : { ...init, body: JSON.stringify(trimmed) });
    } catch (error) { console.warn('[theater:context-window] skipped:', error.message); return previousFetch(input, init); }
  };
}
module.exports = { RECENT_MESSAGE_WINDOW, isTheaterBody, trimToRecentTheaterWindow };
