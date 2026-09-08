'use strict';

// Final, server-side Theater output guard. The UI setting is a character budget;
// provider token limits are only a first line of defense. This guard also trims
// the actual assistant content before it is persisted, so a provider cannot
// silently return a much longer Theater reply.
const previousFetch = globalThis.fetch;
const THEATER_RE = /OurHome 的[“"]小剧场[”](?:长文|互动)写作引擎/u;
const SUPABASE_LETTERS_RE = /\/rest\/v1\/letters(?:\?|$)/i;
const THEATER_MESSAGE_CATEGORY = '小剧场';
const MAX_CACHE = 1200;
const lengthByAnswer = new Map();

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('\n');
}

function requestedReplyChars(body) {
  const text = `${textOf(body?.system)}\n${textOf(body?.messages?.at(-1)?.content)}`;
  const match = text.match(/(?:完整回复至少|最低长度约为|当前设置的最低长度约为|目标长度约为)\s*(\d+)\s*(?:个中文字符|字)/u);
  return match ? Number(match[1]) : 0;
}

function isTheaterProviderBody(body) {
  return Array.isArray(body?.messages) && body.messages.length > 0 && THEATER_RE.test(textOf(body.system));
}

function extractAssistantText(payload) {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  const choice = choices.find(item => item?.message?.content || item?.text);
  if (choice) return textOf(choice.message?.content || choice.text);
  if (payload?.content) return textOf(payload.content);
  if (payload?.output?.text) return String(payload.output.text);
  return '';
}

function remember(answer, limit) {
  const key = String(answer || '').trim();
  const value = Number(limit);
  if (!key || !Number.isFinite(value) || value <= 0) return;
  lengthByAnswer.delete(key);
  lengthByAnswer.set(key, Math.round(value));
  while (lengthByAnswer.size > MAX_CACHE) lengthByAnswer.delete(lengthByAnswer.keys().next().value);
}

function lookup(answer) {
  return lengthByAnswer.get(String(answer || '').trim()) || 0;
}

function trimAtNaturalBoundary(text, maxChars) {
  const value = String(text || '');
  if (!maxChars || value.length <= maxChars) return value;
  const cut = value.slice(0, maxChars);
  const boundary = Math.max(
    cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'),
    cut.lastIndexOf('；'), cut.lastIndexOf('…'), cut.lastIndexOf('\n'), cut.lastIndexOf('!'), cut.lastIndexOf('?'), cut.lastIndexOf(';'),
  );
  if (boundary >= Math.max(20, Math.floor(maxChars * 0.72))) return cut.slice(0, boundary + 1).trimEnd();
  return cut.trimEnd();
}

function capAssistantInsert(body) {
  if (!body || body.category !== THEATER_MESSAGE_CATEGORY || body.author !== '泽' || typeof body.content !== 'string') return body;
  const limit = lookup(body.content);
  if (!limit || body.content.length <= limit) return body;
  return { ...body, content: trimAtNaturalBoundary(body.content, limit) };
}

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function theaterHardCapFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url || '';
    if (typeof init?.body !== 'string') return previousFetch(input, init);
    try {
      const body = JSON.parse(init.body);
      if (SUPABASE_LETTERS_RE.test(url)) {
        const cappedInsert = capAssistantInsert(body);
        return previousFetch(input, cappedInsert === body ? init : { ...init, body: JSON.stringify(cappedInsert) });
      }
      if (!isTheaterProviderBody(body)) return previousFetch(input, init);
      const limit = requestedReplyChars(body);
      const response = await previousFetch(input, init);
      if (limit > 0) {
        try {
          const payload = await response.clone().json();
          const answer = extractAssistantText(payload);
          if (answer) remember(answer, limit);
        } catch {
          // Keep the original provider response flowing when the relay is not JSON.
        }
      }
      return response;
    } catch (error) {
      console.warn('[theater:hard-cap] skipped:', error.message);
      return previousFetch(input, init);
    }
  };
}

module.exports = { requestedReplyChars, trimAtNaturalBoundary, capAssistantInsert, remember, lookup };
