'use strict';

const SYNTHESIS_TIMEOUT_MS = 110_000;
const RETRYABLE_HTTP = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function compact(value, max = 320) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeJsonBody(init = {}) {
  if (typeof init?.body !== 'string') return null;
  try { return JSON.parse(init.body); } catch { return null; }
}

function purposeFromHeaders(headers) {
  const normalized = new Headers(headers || undefined);
  return compact(normalized.get('X-OurHome-Call-Purpose') || normalized.get('x-ourhome-call-purpose') || '', 120);
}

function isLearningSynthesisRequest(init = {}) {
  return purposeFromHeaders(init.headers) === 'luze-learning-synthesis';
}

function messageText(body = {}) {
  return (Array.isArray(body?.messages) ? body.messages : [])
    .map(message => {
      if (typeof message?.content === 'string') return message.content;
      if (!Array.isArray(message?.content)) return '';
      return message.content.map(block => block?.text || '').filter(Boolean).join('\n');
    })
    .filter(Boolean)
    .join('\n');
}

function extractLine(text, label) {
  const index = String(text || '').indexOf(label);
  if (index < 0) return '';
  return compact(String(text).slice(index + label.length).split('\n')[0], 300);
}

function extractSources(text) {
  const sourceMarker = '下面是刚才拿到的外部资料';
  const markerAt = String(text || '').indexOf(sourceMarker);
  if (markerAt < 0) return [];
  const tail = String(text).slice(markerAt);
  const open = tail.indexOf('[');
  const close = tail.lastIndexOf(']');
  if (open < 0 || close <= open) return [];
  try {
    const parsed = JSON.parse(tail.slice(open, close + 1));
    return Array.isArray(parsed) ? parsed.slice(0, 8) : [];
  } catch {
    return [];
  }
}

function buildFallbackPayload(body = {}, reason = '') {
  const prompt = messageText(body);
  const query = extractLine(prompt, '今天你想看：') || '刚才搜到的东西';
  const why = extractLine(prompt, '为什么会想到：');
  const sources = extractSources(prompt);
  const titles = sources.map(item => compact(item?.title || '', 90)).filter(Boolean).slice(0, 6);
  const title = compact(`暂存｜${query}`, 180);
  const titleLine = titles.length ? `目前先留下这些线索：${titles.join('、')}。` : '刚才搜到的资料已经先留在足迹里。';
  const bodyText = compact(
    `这次整理模型临时没回完，我先把这一趟资料压在房间里，不让它白跑。今天原本想看的是「${query}」。${why ? `起因是：${why}。` : ''}${titleLine}这些内容现在只是暂存线索，还没有完成我的完整判断；之后再碰到这个问题时，可以从这里接着整理。`,
    1200,
  );
  const errorHint = compact(reason, 120);
  return {
    title,
    body: bodyText,
    keywords: [],
    stickers: [
      '这次没写完，资料先留住',
      '以后从这里接着补',
      ...(errorHint ? [`失败原因：${errorHint}`] : []),
    ].slice(0, 3),
    ideas: [],
  };
}

function localFallbackResponse(body, reason = '') {
  return new Response(JSON.stringify({
    id: `ourhome-local-luze-learning-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: 'ourhome-local-learning-fallback',
    content: [{ type: 'text', text: JSON.stringify(buildFallbackPayload(body, reason)) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-OurHome-Local-Response': 'luze-learning-fallback',
    },
  });
}

function isRetryableStatus(status) {
  return RETRYABLE_HTTP.has(Number(status));
}

module.exports = {
  SYNTHESIS_TIMEOUT_MS,
  safeJsonBody,
  purposeFromHeaders,
  isLearningSynthesisRequest,
  isRetryableStatus,
  buildFallbackPayload,
  localFallbackResponse,
};
