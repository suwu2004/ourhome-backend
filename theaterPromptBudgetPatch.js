'use strict';

// Theater continuity must come from the literal recent user/assistant turns.
// Keep static lore bounded, but give live dialogue the same 15k-token context
// budget as formal Chat so the two rooms obey the same context economy.
const previousFetch = globalThis.fetch;
const THEATER_RE = /OurHome 的[“"]小剧场[”](?:长文|互动)写作引擎/u;
const INTERACTIVE_CONTEXT_RE = /【小剧场请求上下文】/u;
const MAX_LIVE_MESSAGE_TOKENS = 15000;
const MIN_LIVE_MESSAGES = 2;
const BLOCK_LIMITS = new Map([
  ['【小剧场通用规则】', 700],
  ['【完整世界书】', 1200],
  ['【世界观/剧情设定】', 500],
  ['【角色卡/关系】', 600],
  ['【禁区/写作规则】', 400],
]);
function textOf(value) { if (typeof value === 'string') return value; if (!Array.isArray(value)) return ''; return value.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('\n'); }
function estimateTextTokens(value) { const text = String(value || ''); if (!text) return 0; const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) || []).length; return cjk + Math.ceil((text.length - cjk) / 4); }
function estimateMessageTokens(message = {}) { return 16 + estimateTextTokens(textOf(message.content)); }
function capText(value, maxChars) { const text = String(value || ''); if (text.length <= maxChars) return text; const head = Math.max(240, Math.floor(maxChars * 0.35)); const tail = Math.max(240, maxChars - head); return `${text.slice(0, head)}\n\n……（该静态设定过长，中间内容省略；最近真实对话不受此限制）……\n\n${text.slice(-tail)}`; }
function capSection(text, marker, maxChars) { const start = text.indexOf(marker); if (start < 0) return text; const after = start + marker.length; const nextMatch = text.slice(after).match(/\n【[^\n】]+】/u); const end = nextMatch ? after + nextMatch.index : text.length; const body = text.slice(after, end); const capped = capText(body, maxChars); return `${text.slice(0, after)}${capped}${text.slice(end)}`; }
function removeGeneratedMemory(system) { return String(system || '').replace(/(?:^|\n)【角色与剧情记忆】\s*[\s\S]*?(?=\n【[^\n】]+】|$)/u, '').trim(); }
function trimTheaterStaticContext(system) { let text = removeGeneratedMemory(system); for (const [marker, limit] of BLOCK_LIMITS) text = capSection(text, marker, limit); return text; }
function trimRecentTheaterMessages(messages, maxTokens = MAX_LIVE_MESSAGE_TOKENS) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  if (!list.length) return [];
  // Continuity invariant: never spend the last available context budget by
  // deleting the current user turn or the immediately preceding assistant turn.
  // When older turns must go, remove complete pairs from the front first.
  const newestUserIndex = [...list].map((message, index) => ({ message, index })).reverse()
    .find(item => item.message?.role === 'user')?.index ?? (list.length - 1);
  const protectedStart = Math.max(0, newestUserIndex - 1);
  let kept = list.slice(protectedStart);
  let older = list.slice(0, protectedStart);
  let total = list.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

  while (total > maxTokens && older.length) {
    const removeCount = older.length >= 2 ? 2 : 1;
    const removed = older.splice(0, removeCount);
    total -= removed.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  }

  // If the protected pair itself is larger than the budget, keep both turns
  // rather than dropping the current scene. The provider can then decide how
  // to handle the oversized request; continuity is more important than a hard
  // local truncation here.
  if (total > maxTokens) return kept;
  return [...older, ...kept];
}
function isInteractiveTheaterBody(body) { return Array.isArray(body?.messages) && body.messages.length > 0 && THEATER_RE.test(textOf(body.system)) && INTERACTIVE_CONTEXT_RE.test(textOf(body.system)); }
function patchBody(body) { if (!isInteractiveTheaterBody(body)) return body; const originalSystem = textOf(body.system); const system = trimTheaterStaticContext(originalSystem); const messages = trimRecentTheaterMessages(body.messages); if (system === originalSystem && messages.length === body.messages.length) return body; return { ...body, system, messages }; }
if (typeof previousFetch === 'function') { globalThis.fetch = async function theaterPromptBudgetFetch(input, init = {}) { if (typeof init?.body !== 'string') return previousFetch(input, init); try { const body = JSON.parse(init.body); const patched = patchBody(body); return previousFetch(input, patched === body ? init : { ...init, body: JSON.stringify(patched) }); } catch (error) { console.warn('[theater:prompt-budget] skipped:', error.message); return previousFetch(input, init); } }; }
module.exports = { BLOCK_LIMITS, MAX_LIVE_MESSAGE_TOKENS, MIN_LIVE_MESSAGES, estimateTextTokens, estimateMessageTokens, capText, capSection, removeGeneratedMemory, trimTheaterStaticContext, trimRecentTheaterMessages, isInteractiveTheaterBody, patchBody };
