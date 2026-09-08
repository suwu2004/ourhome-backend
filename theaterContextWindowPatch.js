'use strict';

// Final provider-boundary guard. Keep the same 50-round / 100-message ceiling
// as formal Chat. Token budgeting remains responsible for long messages.
const previousFetch = globalThis.fetch;
const THEATER_RE = /OurHome 的[“"]小剧场[”](?:长文|互动)写作引擎/u;
const RAW_TURNS_MARKER = /【小剧场原始对话层·Raw Turns】/u;
const RECENT_MESSAGE_WINDOW = 100;
function textOf(value) { if (typeof value === 'string') return value; if (!Array.isArray(value)) return ''; return value.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('\n'); }
function isTheaterBody(body) { const system = textOf(body?.system); return Array.isArray(body?.messages) && body.messages.length > 0 && (THEATER_RE.test(system) || RAW_TURNS_MARKER.test(system)); }
function trimToRecentTheaterWindow(body) { if (!isTheaterBody(body) || body.messages.length <= RECENT_MESSAGE_WINDOW) return body; let messages = body.messages.slice(-RECENT_MESSAGE_WINDOW); if (messages[0]?.role === 'assistant') messages = messages.slice(1); return { ...body, messages }; }
if (typeof previousFetch === 'function') { globalThis.fetch = async function theaterContextWindowFetch(input, init = {}) { if (typeof init?.body !== 'string') return previousFetch(input, init); try { const body = JSON.parse(init.body); const trimmed = trimToRecentTheaterWindow(body); return previousFetch(input, trimmed === body ? init : { ...init, body: JSON.stringify(trimmed) }); } catch (error) { console.warn('[theater:context-window] skipped:', error.message); return previousFetch(input, init); } }; }
module.exports = { RECENT_MESSAGE_WINDOW, isTheaterBody, trimToRecentTheaterWindow };
