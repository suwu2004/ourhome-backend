'use strict';

// Preserve provider-native thinking for formal OurHome Chat requests sent through
// Anthropic-compatible /messages relays. The old version depended on two exact
// prompt headings; that was too brittle because prompt cleanup/context layers
// can legitimately change those headings. We identify formal Chat by the
// /messages shape + an OurHome system prompt, while explicitly excluding Theater.
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
    return message.content.map(block => typeof block === 'string' ? block : block?.text || block?.content || '').filter(Boolean).join('\n');
  }).join('\n');
}

function isTheaterRequest(body) {
  const text = systemText(body?.system);
  return /OurHome 的[“"]小剧场[”](?:长文|互动)写作引擎/u.test(text);
}

function isMainChatRequest(url, body = {}) {
  if (!/\/messages(?:\?|$)/i.test(String(url || ''))) return false;
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return false;
  if (isTheaterRequest(body)) return false;

  const system = systemText(body.system);
  // Formal Chat normally carries one or more OurHome system blocks. Keep the
  // fallback broad enough to survive prompt refactors, but never touch an
  // unrelated provider request merely because its endpoint is /messages.
  return /OurHome|叶檀/u.test(system);
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
  return /(?:^|[-_:])(thinking|reasoning)(?:[-_:]|$)|(?:^|[-_:])(?:claude-)?(?:opus|sonnet|haiku)-4-[56](?:[-_:]|$)|^o[134](?:[-_:]|$)/i.test(String(model || ''));
}

function modelUsesAdaptiveThinking(model) {
  return /(?:^|[-_:])(?:claude-)?(?:opus|sonnet|haiku)-4-6(?:[-_:]|$)/i.test(String(model || ''));
}

function isOfficialAnthropicUrl(url) {
  return /^https:\/\/api\.anthropic\.com(?:\/|$)/i.test(String(url || ''));
}

function thinkingBudgetFor(body) {
  const maxTokens = Number(body?.max_tokens || 0);
  if (maxTokens > 4096) return 4096;
  if (maxTokens > 2048) return Math.min(2048, maxTokens - 1);
  return 1024;
}

function prepareMainChatRequest(url, body, headersInit) {
  const nextBody = { ...body };
  const headers = new Headers(headersInit || undefined);

  if (!nextBody.thinking && modelRequestsNativeThinking(nextBody.model)) {
    const budget = thinkingBudgetFor(nextBody);
    // Claude 4.6 supports adaptive thinking; Claude 4.5 is manual-only.
    // The model suffix in OurHome is an alias, while the relay returns the
    // canonical model name (for example claude-opus-4.5), so choose the wire
    // format from the requested model rather than assuming every "*thinking"
    // alias is adaptive-capable.
    if (modelUsesAdaptiveThinking(nextBody.model)) {
      nextBody.thinking = { type: 'adaptive', display: 'summarized' };
      nextBody.output_config = { ...(nextBody.output_config || {}), effort: 'high' };
      headers.delete('anthropic-beta');
    } else {
      nextBody.thinking = { type: 'enabled', budget_tokens: budget, display: 'summarized' };
      headers.set('anthropic-beta', 'interleaved-thinking-2025-05-14');
      delete nextBody.output_config;
    }
    // Thinking requires temperature=1 (or unset).
    nextBody.temperature = 1;
  }

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
        console.log('[thinking:transport] native thinking enabled', {
          model: prepared.body.model,
          budget_tokens: prepared.body.thinking?.budget_tokens,
          max_tokens: prepared.body.max_tokens,
        });
        console.log('[thinking:wire] outbound', {
          model: prepared.body.model,
          thinking: prepared.body.thinking,
          output_config: prepared.body.output_config,
          temperature: prepared.body.temperature,
          anthropic_beta: prepared.headers.get('anthropic-beta'),
          max_tokens: prepared.body.max_tokens,
        });
        const response = await originalFetch(input, { ...init, headers: prepared.headers, body: JSON.stringify(prepared.body) });
        try {
          const preview = await response.clone().json();
          const blocks = Array.isArray(preview?.content) ? preview.content.map(block => block?.type || typeof block) : [];
          console.log('[thinking:wire] inbound', {
            status: response.status,
            blockTypes: blocks,
            hasThinking: blocks.includes('thinking'),
            responseModel: preview?.model || null,
          });
        } catch (error) {
          console.warn('[thinking:wire] inbound parse skipped:', error.message);
        }
        return response;
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
    if (body?.message === '在云端漫步' && body?.status === 'ok') body = { ...body, thinking_transport: 'native-and-relay-v11' };
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[thinking:transport] health marker unavailable:', error.message);
}

module.exports = { isMainChatRequest, isThinkingDecisionRequest, prepareMainChatRequest };
