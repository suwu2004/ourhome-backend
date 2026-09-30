'use strict';

// A window-summary request used to make one provider call per 12k-char chunk.
// The first economy patch only inspected `messages`, while the current summary
// transport can place the chunk prompt in `system`; that made the guard a no-op.
// Inspect the complete JSON request and synthesize later chunks locally.
const previousFetch = globalThis.fetch;
const MAX_MODEL_CHUNKS = 4;

function compact(value, max = 900) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractPrompt(body) {
  const parts = [];
  if (typeof body?.system === 'string') parts.push(body.system);
  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      if (typeof message?.content === 'string') parts.push(message.content);
      else if (Array.isArray(message?.content)) {
        for (const item of message.content) {
          if (typeof item?.text === 'string') parts.push(item.text);
        }
      }
    }
  }
  return parts.join('\n');
}

function localChunkDigest(prompt) {
  const match = String(prompt || '').match(/聊天段落：\s*([\s\S]*?)\s*输出不超过260字/);
  const text = match?.[1] || '';
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) return '本段聊天没有可提取的正文。';
  const head = lines.slice(0, 2).join('；');
  const tail = lines.slice(-2).join('；');
  if (lines.length <= 4) return compact(head, 500);
  return compact(`本段前部：${head}；本段后部：${tail}`, 900);
}

function syntheticAnthropicResponse(text) {
  const body = JSON.stringify({
    id: `local-summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'message',
    role: 'assistant',
    model: 'ourhome-local-summary',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: Math.ceil(String(text).length / 2) },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function sessionSummaryEconomyFetch(input, init = {}) {
    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        const prompt = extractPrompt(body);
        const match = prompt.match(/第\s*(\d+)\/(\d+)\s*段聊天记录/);
        if (match) {
          const chunkIndex = Number(match[1]);
          const total = Number(match[2]);
          if (Number.isFinite(chunkIndex) && Number.isFinite(total) && chunkIndex >= MAX_MODEL_CHUNKS) {
            console.log(`[session-summary:economy] local chunk ${chunkIndex + 1}/${total} (provider call skipped)`);
            return syntheticAnthropicResponse(localChunkDigest(prompt));
          }
        }
      } catch (error) {
        console.warn('[session-summary:economy] request inspection skipped:', error.message);
      }
    }
    return previousFetch(input, init);
  };
}
