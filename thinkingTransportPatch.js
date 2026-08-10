'use strict';

// OurHome Chat treats visible reasoning as optional provider metadata.
// Never buy a separate “visible thought” completion and never ask ordinary
// non-thinking models to simulate one in prose. If the selected provider/model
// already supports a native thinking request, preserve that request and pass the
// provider's native reasoning response through unchanged for server.js to extract.
const originalFetch = globalThis.fetch;

function systemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map(block => typeof block === 'string' ? block : block?.text || block?.content || '')
    .filter(Boolean)
    .join('\n');
}

function messageText(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map(message => {
      if (typeof message?.content === 'string') return message.content;
      if (!Array.isArray(message?.content)) return '';
      return message.content
        .map(block => typeof block === 'string' ? block : block?.text || '')
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

function stripLegacyThinkingInstruction(value) {
  return String(value || '')
    .replace(/\n*【可见的内心独白】[\s\S]*$/u, '')
    .replace(/\n*【每轮可见思考】[\s\S]*$/u, '')
    .replace(/\n*【可见思考协议】[\s\S]*$/u, '')
    .trimEnd();
}

function sanitizeChatSystem(system) {
  if (typeof system === 'string') return stripLegacyThinkingInstruction(system);
  if (!Array.isArray(system)) return system;
  return system.map(block => {
    if (typeof block === 'string') return stripLegacyThinkingInstruction(block);
    if (!block || typeof block !== 'object') return block;
    if (typeof block.text === 'string') return { ...block, text: stripLegacyThinkingInstruction(block.text) };
    if (typeof block.content === 'string') return { ...block, content: stripLegacyThinkingInstruction(block.content) };
    return block;
  });
}

function isMainChatRequest(url, body) {
  if (!/\/messages(?:\?|$)/i.test(String(url || ''))) return false;
  const text = systemText(body?.system);
  return text.includes('【回复长度】')
    && text.includes('【OurHome 房间与入口认知（事实规则）】');
}

function isThinkingDecisionRequest(url, body) {
  if (!/\/messages(?:\?|$)/i.test(String(url || ''))) return false;
  const text = messageText(body?.messages);
  return Number(body?.max_tokens || 0) <= 20
    && text.includes('只回答一个词')
    && text.includes('想 或者 不想');
}

function fixedNoThinkResponse() {
  return new Response(JSON.stringify({
    id: 'ourhome-no-synthetic-thinking',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: '不想' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-OurHome-Local-Response': 'thinking-decision',
    },
  });
}

function prepareMainChatRequest(url, body, headersInit) {
  const nextBody = { ...body, system: sanitizeChatSystem(body?.system) };
  const headers = new Headers(headersInit || undefined);

  // Do not delete nextBody.thinking here. server.js only supplies it for the
  // selected model path that requested native extended thinking. Removing it was
  // the reason genuine provider thinking disappeared from some Chat replies.
  // Relay-only simulated thinking lives in the system prompt and is stripped above.
  // Some relays reject Anthropic's beta header while still accepting the native
  // body shape, so keep that header only for Anthropic's official endpoint.
  if (!/^https:\/\/api\.anthropic\.com(?:\/|$)/i.test(String(url || ''))) {
    headers.delete('anthropic-beta');
  }

  return { body: nextBody, headers };
}

if (typeof originalFetch === 'function') {
  globalThis.fetch = async function nativeThinkingOnlyFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;

    if (typeof init?.body !== 'string') return originalFetch(input, init);

    try {
      const body = JSON.parse(init.body);

      // Legacy server code still asks a tiny “think or not” question for some
      // models. Resolve it locally so this branch can never become a paid call.
      if (isThinkingDecisionRequest(url, body)) return fixedNoThinkResponse();

      if (isMainChatRequest(url, body)) {
        const prepared = prepareMainChatRequest(url, body, init.headers);
        return originalFetch(input, {
          ...init,
          headers: prepared.headers,
          body: JSON.stringify(prepared.body),
        });
      }
    } catch (error) {
      console.warn('[thinking:native-only] request patch skipped:', error.message);
    }

    return originalFetch(input, init);
  };
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function nativeThinkingHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, thinking_transport: 'native-only-thinking-v8' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[thinking:native-only] health marker unavailable:', error.message);
}

module.exports = {
  isMainChatRequest,
  isThinkingDecisionRequest,
  sanitizeChatSystem,
  prepareMainChatRequest,
};
