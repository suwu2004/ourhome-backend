'use strict';

// The Theater generator deliberately uses a fixed recent-message window.
// Keep this enforcement at the final provider boundary so later wrappers
// cannot accidentally widen the generation context again.
const previousFetch = globalThis.fetch;
const THEATER_RE = /OurHome 的[“"]小剧场[”"](?:长文|互动)写作引擎/u;
const RAW_TURNS_MARKER = '【小剧场原始对话层·Raw Turns】';
const RECENT_MESSAGE_WINDOW = 18;

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('\n');
}

function isTheaterBody(body) {
  return Array.isArray(body?.messages) && body.messages.length > 0 && THEATER_RE.test(textOf(body.system));
}

function trimToRecentTheaterWindow(body) {
  if (!isTheaterBody(body) || !body.messages.some(message => textOf(message?.content).includes(RAW_TURNS_MARKER))) return body;
  if (body.messages.length <= RECENT_MESSAGE_WINDOW) return body;
  const kept = body.messages.slice(-RECENT_MESSAGE_WINDOW);
  return { ...body, messages: kept };
}

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function theaterContextWindowFetch(input, init = {}) {
    if (typeof init?.body !== 'string') return previousFetch(input, init);
    try {
      const body = JSON.parse(init.body);
      const trimmed = trimToRecentTheaterWindow(body);
      return previousFetch(input, trimmed === body ? init : { ...init, body: JSON.stringify(trimmed) });
    } catch (error) {
      console.warn('[theater:context-window] skipped:', error.message);
      return previousFetch(input, init);
    }
  };
}

module.exports = {
  RECENT_MESSAGE_WINDOW,
  isTheaterBody,
  trimToRecentTheaterWindow,
};
