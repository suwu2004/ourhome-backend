'use strict';

// The Theater setting is a character-length budget, while providers receive
// token limits. Read the same explicit adaptive-length instruction used by the
// server and prevent a generous fallback max_tokens from silently overriding it.
const previousFetch = globalThis.fetch;
const THEATER_RE = /OurHome 的[“"]小剧场[”](?:长文|互动)写作引擎/u;
const LENGTH_RE = /(?:完整回复至少|最低长度约为|当前设置的最低长度约为|目标长度约为)\s*(\d+)\s*(?:个中文字符|字)(?:左右|的最低篇幅)?/u;
const MAX_MULTIPLIER = 1.2;
const SAFETY_TOKENS = 32;
const MIN_PROVIDER_TOKENS = 128;
const MAX_PROVIDER_TOKENS = 5200;
function textOf(value) { if (typeof value === 'string') return value; if (!Array.isArray(value)) return ''; return value.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('\n'); }
function isTheaterBody(body) { return Array.isArray(body?.messages) && body.messages.length > 0 && THEATER_RE.test(textOf(body.system)); }
function requestedReplyChars(body) { const text = `${textOf(body.system)}\n${textOf(body.messages?.at(-1)?.content)}`; const match = text.match(LENGTH_RE); return match ? Number(match[1]) : 0; }
function capProviderTokens(body) {
  if (!isTheaterBody(body)) return body;
  const requestedChars = requestedReplyChars(body);
  if (!Number.isFinite(requestedChars) || requestedChars <= 0) return body;
  const configuredKeys = ['max_tokens', 'maxTokens', 'max_completion_tokens', 'maxCompletionTokens'];
  const configured = configuredKeys.map(key => Number(body[key])).find(value => Number.isFinite(value) && value > 0) || 0;
  const budget = Math.min(MAX_PROVIDER_TOKENS, Math.max(MIN_PROVIDER_TOKENS, Math.ceil(requestedChars * MAX_MULTIPLIER + SAFETY_TOKENS)));
  if (configured > 0 && configured <= budget) return body;
  const next = { ...body };
  const providerKey = configuredKeys.find(key => key in next) || 'max_tokens';
  next[providerKey] = budget;
  // Remove conflicting token-limit aliases so the relay cannot prefer a stale,
  // larger value over the capped budget.
  for (const key of configuredKeys) {
    if (key !== providerKey && key in next) delete next[key];
  }
  return next;
}
if (typeof previousFetch === 'function') { globalThis.fetch = async function theaterReplyLengthGuardFetch(input, init = {}) { if (typeof init?.body !== 'string') return previousFetch(input, init); try { const body = JSON.parse(init.body); const capped = capProviderTokens(body); return previousFetch(input, capped === body ? init : { ...init, body: JSON.stringify(capped) }); } catch (error) { console.warn('[theater:reply-length-guard] skipped:', error.message); return previousFetch(input, init); } }; }
module.exports = { MAX_MULTIPLIER, SAFETY_TOKENS, requestedReplyChars, capProviderTokens, isTheaterBody };
