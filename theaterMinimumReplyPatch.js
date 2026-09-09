'use strict';

// A character setting cannot be made reliable by max_tokens alone: a model can
// legally stop early. For Theater, if a reply is below the configured minimum,
// make one continuation pass and merge it before the response reaches the UI.
const previousFetch = globalThis.fetch;
const THEATER_RE = /OurHome 的[“"]小剧场[”](?:长文|互动)写作引擎/u;
const LENGTH_RE = /(?:完整回复至少|最低长度约为|当前设置的最低长度约为|目标长度约为)\s*(\d+)\s*(?:个中文字符|字)/u;
const MIN_RATIO = 0.95;
const MAX_FINAL_RATIO = 1.10;

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('\n');
}

function requestedReplyChars(body) {
  const text = `${textOf(body?.system)}\n${textOf(body?.messages?.at(-1)?.content)}`;
  const match = text.match(LENGTH_RE);
  return match ? Number(match[1]) : 0;
}

function isTheaterBody(body) {
  return Array.isArray(body?.messages) && body.messages.length > 0 && THEATER_RE.test(textOf(body.system));
}

function extractText(payload) {
  const anthropic = Array.isArray(payload?.content)
    ? payload.content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n').trim()
    : '';
  if (anthropic) return anthropic;
  const choice = payload?.choices?.[0];
  return String(choice?.message?.content || choice?.text || payload?.output?.text || payload?.content || '').trim();
}

function replaceText(payload, text) {
  const next = JSON.parse(JSON.stringify(payload));
  if (Array.isArray(next?.content)) {
    let replaced = false;
    next.content = next.content.map(block => {
      if (!replaced && block?.type === 'text') {
        replaced = true;
        return { ...block, text };
      }
      return block;
    });
    if (!replaced) next.content = [{ type: 'text', text }];
    return next;
  }
  if (next?.choices?.[0]?.message) {
    next.choices[0].message = { ...next.choices[0].message, content: text };
    return next;
  }
  if (next?.choices?.[0]) {
    next.choices[0] = { ...next.choices[0], text };
    return next;
  }
  if (typeof next?.output?.text === 'string') {
    next.output.text = text;
    return next;
  }
  next.content = text;
  return next;
}

function addUsage(first, second) {
  if (!first?.usage && !second?.usage) return first;
  const next = { ...first, usage: { ...(first.usage || {}) } };
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens']) {
    const a = Number(first?.usage?.[key]);
    const b = Number(second?.usage?.[key]);
    if (Number.isFinite(a) || Number.isFinite(b)) next.usage[key] = (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);
  }
  return next;
}

function continuationBody(body, answer, remainingChars) {
  const next = { ...body };
  const originalMessages = Array.isArray(body.messages) ? [...body.messages] : [];
  next.messages = [
    ...originalMessages,
    { role: 'assistant', content: answer },
    {
      role: 'user',
      content: `刚才的剧情回复只有约 ${answer.length} 个字符，而本次设置要求至少约 ${requestedReplyChars(body)} 个中文字符。请紧接着上一段自然续写，把当前这一轮完整展开到至少约 ${remainingChars} 个字符的新增内容；不要重复已经写过的句子，不要总结，不要解释规则，不要另起无关剧情，保持人物、动作和场景连续，并在自然完整的句子或段落处结束。`,
    },
  ];
  const tokenKeys = ['max_tokens', 'maxTokens', 'max_completion_tokens', 'maxCompletionTokens'];
  const existingKey = tokenKeys.find(key => key in next);
  const available = existingKey ? Number(next[existingKey]) : 0;
  const needed = Math.max(256, Math.min(5200, Math.ceil(remainingChars * 1.35) + 32));
  if (existingKey) next[existingKey] = Math.min(available > 0 ? available : needed, needed);
  else next.max_tokens = needed;
  return next;
}

function makeResponse(originalResponse, payload) {
  const headers = new Headers(originalResponse.headers || {});
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(payload), {
    status: originalResponse.status,
    statusText: originalResponse.statusText,
    headers,
  });
}

async function enforceMinimum(input, init) {
  const body = JSON.parse(init.body);
  if (!isTheaterBody(body)) return previousFetch(input, init);
  const minimum = requestedReplyChars(body);
  const firstResponse = await previousFetch(input, init);
  if (!minimum || !firstResponse.ok) return firstResponse;

  let firstPayload;
  try {
    firstPayload = await firstResponse.clone().json();
  } catch {
    return firstResponse;
  }
  const firstText = extractText(firstPayload);
  if (!firstText || firstText.length >= Math.ceil(minimum * MIN_RATIO)) return firstResponse;

  const remaining = Math.max(1, minimum - firstText.length);
  const retryBody = continuationBody(body, firstText, remaining);
  const retryResponse = await previousFetch(input, { ...init, body: JSON.stringify(retryBody) });
  if (!retryResponse.ok) return firstResponse;

  let secondPayload;
  try {
    secondPayload = await retryResponse.clone().json();
  } catch {
    return firstResponse;
  }
  const secondText = extractText(secondPayload);
  if (!secondText) return firstResponse;

  const merged = `${firstText}\n\n${secondText}`.trim();
  const finalLimit = Math.ceil(minimum * MAX_FINAL_RATIO);
  const finalText = merged.length > finalLimit ? merged.slice(0, finalLimit).trimEnd() : merged;
  const finalPayload = replaceText(firstPayload, finalText);
  return makeResponse(firstResponse, addUsage(finalPayload, secondPayload));
}

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function theaterMinimumReplyFetch(input, init = {}) {
    if (typeof init?.body !== 'string') return previousFetch(input, init);
    try {
      return await enforceMinimum(input, init);
    } catch (error) {
      console.warn('[theater:minimum-reply] skipped:', error.message);
      return previousFetch(input, init);
    }
  };
}

module.exports = {
  MIN_RATIO,
  MAX_FINAL_RATIO,
  requestedReplyChars,
  isTheaterBody,
  extractText,
  continuationBody,
};
