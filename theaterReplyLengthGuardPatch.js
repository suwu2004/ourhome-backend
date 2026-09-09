'use strict';

// One-call Theater reply-length guard. The UI setting is a character target,
// not a request for a second completion. We make the target explicit in the
// provider system prompt and reserve enough output tokens for the model to
// finish naturally in one call.
const previousFetch = globalThis.fetch;
const THEATER_RE = /OurHome 的[“"]小剧场[”](?:长文|互动)写作引擎/u;
const LENGTH_RE = /(?:完整回复至少|最低长度约为|当前设置的最低长度约为|目标长度约为)\s*(\d+)\s*(?:个中文字符|字)(?:左右|的最低篇幅)?/u;
const MAX_MULTIPLIER = 1.6;
const SAFETY_TOKENS = 64;
const MIN_PROVIDER_TOKENS = 128;
const MAX_PROVIDER_TOKENS = 5200;

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('\n');
}

function isTheaterBody(body) {
  return Array.isArray(body?.messages) && body.messages.length > 0 && THEATER_RE.test(textOf(body.system));
}

function requestedReplyChars(body) {
  const text = `${textOf(body.system)}\n${textOf(body.messages?.at(-1)?.content)}`;
  const match = text.match(LENGTH_RE);
  return match ? Number(match[1]) : 0;
}

function appendLengthInstruction(system, requestedChars) {
  const source = textOf(system).trim();
  const instruction = `【小剧场回复长度】本次回复目标约为 ${requestedChars} 个中文字符。请在一次回复中自然完成完整场景、动作、对白与剧情推进，尽量写到目标篇幅附近；不要因为达到一个短段落就提前结束，也不要用重复、注水或无意义的句子凑字数。除非剧情确实需要，不要主动大幅超过目标篇幅。`;
  if (source.includes('【小剧场回复长度】')) {
    return source.replace(/【小剧场回复长度】[\s\S]*$/u, instruction);
  }
  return `${source}\n\n${instruction}`.trim();
}

function capProviderTokens(body) {
  if (!isTheaterBody(body)) return body;
  const requestedChars = requestedReplyChars(body);
  if (!Number.isFinite(requestedChars) || requestedChars <= 0) return body;

  const configuredKeys = ['max_tokens', 'maxTokens', 'max_completion_tokens', 'maxCompletionTokens'];
  const configured = configuredKeys.map(key => Number(body[key])).find(value => Number.isFinite(value) && value > 0) || 0;
  const budget = Math.min(MAX_PROVIDER_TOKENS, Math.max(MIN_PROVIDER_TOKENS, Math.ceil(requestedChars * MAX_MULTIPLIER + SAFETY_TOKENS)));
  const next = { ...body };
  next.system = appendLengthInstruction(body.system, requestedChars);

  // Never let an existing provider limit be too small for the configured
  // character target. Keep a reasonable ceiling so a setting cannot explode
  // provider cost, while the final hard-cap guard handles overlong output.
  if (configured <= 0 || configured > budget) {
    const providerKey = configuredKeys.find(key => key in next) || 'max_tokens';
    next[providerKey] = budget;
    for (const key of configuredKeys) {
      if (key !== providerKey && key in next) delete next[key];
    }
  }

  return next;
}

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function theaterReplyLengthGuardFetch(input, init = {}) {
    if (typeof init?.body !== 'string') return previousFetch(input, init);
    try {
      const body = JSON.parse(init.body);
      const capped = capProviderTokens(body);
      return previousFetch(input, capped === body ? init : { ...init, body: JSON.stringify(capped) });
    } catch (error) {
      console.warn('[theater:reply-length-guard] skipped:', error.message);
      return previousFetch(input, init);
    }
  };
}

module.exports = { MAX_MULTIPLIER, SAFETY_TOKENS, requestedReplyChars, appendLengthInstruction, capProviderTokens, isTheaterBody };
