'use strict';

// Preserve both supported paths:
// 1) official Anthropic native extended thinking;
// 2) relay fallback, where server.js asks the model to emit <thinking>...</thinking>.
// This transport layer must not delete the relay fallback instruction before the
// request reaches the provider.
const originalFetch = globalThis.fetch;

function systemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system.map(block => typeof block === 'string' ? block : block?.text || block?.content || '').filter(Boolean).join('\n');
}

function messageText(messages) {
  return (Array.isArray(messages) ? messages : []).map(message => {
    if (typeof message?.content === 'string') return message.content;
    if (!Array.isArray(message?.content)) return '';
    return message.content.map(block => typeof block === 'string' ? block : block?.text || '').filter(Boolean).join('\n');
  }).join('\n');
}

function isMainChatRequest(url, body) {
  if (!/\/messages(?:\?|$)/i.test(String(url || ''))) return false;
  const text = systemText(body?.system);
  return text.includes('【回复长度】') && text.includes('【OurHome 房间与入口认知（事实规则）】');
}

function isThinkingDecisionRequest(url, body) {
  if (!/\/messages(?:\?|$)/i.test(String(url || ''))) return false;
  const text = messageText(body?.messages);
  return Number(body?.max_tokens || 0) <= 20 && text.includes('只回答一个词') && text.includes('想 或者 不想');
}

function fixedNoThinkResponse() {
  return new Response(JSON.stringify({
    id: 'ourhome-no-synthetic-thinking', type: 'message', role: 'assistant',
    content: [{ type: 'text', text: '不想' }], stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
  }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-OurHome-Local-Response': 'thinking-decision' } });
}

function modelRequestsNativeThinking(model) {
  return /(?:^|[-_:])(thinking|reasoning)(?:[-_:]|$)|^o[134](?:[-_:]|$)/i.test(String(model || ''));
}

function isOfficialAnthropicUrl(url) {
  return /^https:\/\/api\.anthropic\.com(?:\/|$)/i.test(String(url || ''));
}

function prepareMainChatRequest(url, body, headersInit) {
  // Important: leave body.system untouched. For relay requests, server.js may
  // have appended the visible-thinking fallback instruction. The old version
  // stripped that instruction here, so thinking models became ordinary replies.
  const nextBody = { ...body };
  const headers = new Headers(headersInit || undefined);

  // Anthropic's native thinking body shape is valid only on the official
  // Anthropic endpoint. Never inject it into relay/OpenAI/Gemini endpoints just
  // because the model name contains "thinking".
  if (isOfficialAnthropicUrl(url) && !nextBody.thinking && modelRequestsNativeThinking(nextBody.model)) {
    nextBody.thinking = { type: 'enabled', budget_tokens: 2048 };
  }

  // Preserve an explicitly supplied native thinking request. Do not delete it.
  if (!isOfficialAnthropicUrl(url)) headers.delete('anthropic-beta');
  return { body: nextBody, headers };
}

if (typeof originalFetch === 'function') {
  globalThis.fetch = async function thinkingTransportFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (typeof init?.body !== 'string') return originalFetch(input, init);
    try {
      const body = JSON.parse(init.body);
      if (isThinkingDecisionRequest(url, body)) return fixedNoThinkResponse();
      if (isMainChatRequest(url, body)) {
        const prepared = prepareMainChatRequest(url, body, init.headers);
        return originalFetch(input, { ...init, headers: prepared.headers, body: JSON.stringify(prepared.body) });
      }
    } catch (error) {
      console.warn('[thinking:transport] request patch skipped:', error.message);
    }
    return originalFetch(input, init);
  };
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function thinkingHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') body = { ...body, thinking_transport: 'native-and-relay-fallback-v9' };
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[thinking:transport] health marker unavailable:', error.message);
}

module.exports = { isMainChatRequest, isThinkingDecisionRequest, prepareMainChatRequest };
