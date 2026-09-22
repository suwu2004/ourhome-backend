'use strict';

// Preserve provider-native thinking for official Anthropic and compatible relay
// endpoints. A model name containing "thinking" is not sufficient by itself,
// but the selected OurHome thinking models use the Anthropic Messages shape.
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

function thinkingBudgetFor(body) {
  const maxTokens = Number(body?.max_tokens || 0);
  // Anthropic requires budget_tokens to be < max_tokens for normal manual
  // thinking. Our Chat defaults can legitimately set max_tokens to 4000, so a
  // fixed 4096 budget makes every thinking-model request fail with HTTP 400.
  if (maxTokens <= 1024) return 0;
  if (maxTokens > 4096) return 4096;
  return Math.max(1024, maxTokens - 1);
}

function prepareMainChatRequest(url, body, headersInit) {
  const nextBody = { ...body };
  const headers = new Headers(headersInit || undefined);

  // The previous patch only enabled native thinking on api.anthropic.com.
  // OurHome uses an Anthropic-compatible relay, so that condition silently
  // removed the only chance for the relay to return thinking blocks. Pass the
  // same Messages API thinking object through to compatible /messages relays.
  if (!nextBody.thinking && modelRequestsNativeThinking(nextBody.model)) {
    const budget = thinkingBudgetFor(nextBody);
    if (budget >= 1024) {
      nextBody.thinking = { type: 'enabled', budget_tokens: budget };
      nextBody.temperature = 1;
    }
  }

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
    if (body?.message === '在云端漫步' && body?.status === 'ok') body = { ...body, thinking_transport: 'native-and-relay-v10' };
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[thinking:transport] health marker unavailable:', error.message);
}

module.exports = { isMainChatRequest, isThinkingDecisionRequest, prepareMainChatRequest };
