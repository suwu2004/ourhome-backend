'use strict';

// Keep static Theater setup and generated memory from crowding out the actual
// conversational turns. This is a context-budget guard, not a continuity/
// prompt-anchor workaround: recent user/assistant messages remain untouched.
const previousFetch = globalThis.fetch;
const THEATER_RE = /OurHome 的[“"]小剧场[”"](?:长文|互动)写作引擎/u;
const INTERACTIVE_CONTEXT_RE = /【小剧场请求上下文】/u;

const BLOCK_LIMITS = new Map([
  ['【小剧场通用规则】', 5000],
  ['【完整世界书】', 9000],
  ['【世界观/剧情设定】', 4500],
  ['【角色卡/关系】', 4500],
  ['【禁区/写作规则】', 3500],
  // Memory is useful for durable facts, but it is not a substitute for the
  // live transcript. The previous uncapped memory block could grow to tens
  // of thousands of characters and make the model attend to summaries instead
  // of the actual preceding dialogue.
  ['【角色与剧情记忆】', 6500],
]);

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('\n');
}

function capText(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  const head = Math.max(800, Math.floor(maxChars * 0.35));
  const tail = Math.max(800, maxChars - head);
  return `${text.slice(0, head)}\n\n……（该静态设定过长，中间内容省略；最近真实对话不受此限制）……\n\n${text.slice(-tail)}`;
}

function capSection(text, marker, maxChars) {
  const start = text.indexOf(marker);
  if (start < 0) return text;
  const after = start + marker.length;
  const nextMatch = text.slice(after).match(/\n【[^\n】]+】/u);
  const end = nextMatch ? after + nextMatch.index : text.length;
  const body = text.slice(after, end);
  const capped = capText(body, maxChars);
  return `${text.slice(0, after)}${capped}${text.slice(end)}`;
}

function trimTheaterStaticContext(system) {
  let text = String(system || '');
  for (const [marker, limit] of BLOCK_LIMITS) text = capSection(text, marker, limit);
  return text;
}

function isInteractiveTheaterBody(body) {
  return Array.isArray(body?.messages)
    && body.messages.length > 0
    && THEATER_RE.test(textOf(body.system))
    && INTERACTIVE_CONTEXT_RE.test(textOf(body.system));
}

function patchBody(body) {
  if (!isInteractiveTheaterBody(body)) return body;
  const system = trimTheaterStaticContext(textOf(body.system));
  return system === textOf(body.system) ? body : { ...body, system };
}

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function theaterPromptBudgetFetch(input, init = {}) {
    if (typeof init?.body !== 'string') return previousFetch(input, init);
    try {
      const body = JSON.parse(init.body);
      const patched = patchBody(body);
      return previousFetch(input, patched === body ? init : { ...init, body: JSON.stringify(patched) });
    } catch (error) {
      console.warn('[theater:prompt-budget] skipped:', error.message);
      return previousFetch(input, init);
    }
  };
}

module.exports = { BLOCK_LIMITS, capText, capSection, trimTheaterStaticContext, isInteractiveTheaterBody, patchBody };
