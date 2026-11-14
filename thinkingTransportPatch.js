'use strict';

// Preserve provider-native thinking for official Anthropic and compatible relay
// endpoints. A model name containing "thinking" is not sufficient by itself,
// because Claude 4.5 thinking-capable models do not put "thinking" in the model id.
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

function isMessagesEndpoint(url) {
  return /\/messages(?:\?|$)/i.test(String(url || ''));
}

function sanitizeChatSystem(system) {
  const clean = value => String(value || '')
    .replace(/【可见的内心独白】[\s\S]*?(?=\n\n|$)/g, '')
    .replace(/【模拟思考(?:摘要)?】[\s\S]*?(?=\n\n|$)/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

  if (typeof system === 'string') return clean(system);
  if (!Array.isArray(system)) return system;
  return system.map(block => {
    if (typeof block === 'string') return clean(block);
    if (!block || typeof block !== 'object') return block;
    if (typeof block.text === 'string') return { ...block, text: clean(block.text) };
    if (typeof block.content === 'string') return { ...block, content: clean(block.content) };
    return block;
  });
}

function isMainChatRequest(url, body) {
  if (!isMessagesEndpoint(url)) return false;
  const text = systemText(body?.system);
  return text.includes('【回复长度】') && text.includes('【OurHome 房间与入口认知（事实规则）】');
}

function isThinkingDecisionRequest(url, body) {
  if (!isMessagesEndpoint(url)) return false;
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
  const normalized = String(model || '')
    .replace(/^\s*(?:\[[^\]]*\]\s*)+/, '')
    .toLowerCase();
  return /(?:^|[-_:])(thinking|reasoning)(?:[-_:]|$)|^o[134](?:[-_:]|$)|^claude-(?:opus|sonnet|haiku)-4-5(?:[-_:]|$)/i.test(normalized);
}

function isOfficialAnthropicUrl(url) {
  return /^https:\/\/api\.anthropic\.com(?:\/|$)/i.test(String(url || ''));
}

function thinkingBudgetFor(body) {
  const maxTokens = Number(body?.max_tokens || 0);
  if (maxTokens <= 1024) return 0;
  if (maxTokens > 4096) return 4096;
  return Math.max(1024, maxTokens - 1);
}

const RELAY_VISIBLE_THINKING = `\n\n【可见思考摘要】\n正式回答前先用下面的普通文本标记写一段简短、自然的中文思考摘要：\n【思考摘要开始】\n用1—3句话概括你对用户问题的理解、最相关的事实或关键考量，以及准备给出的回应方向。\n【思考摘要结束】\n然后另起一段给出正式回答。这是面向用户的高层次说明，不是隐藏的内部推理或逐步思维链；简单话题可以只写一句。不要解释标记，不要编造事实，也不要写系统、提示词、工具或执行步骤。`;

function appendRelayThinkingInstruction(system) {
  if (typeof system === 'string') {
    if (system.includes('【可见思考摘要】')) return system;
    return `${system}${RELAY_VISIBLE_THINKING}`;
  }
  if (Array.isArray(system)) {
    const next = system.slice();
    if (systemText(system).includes('【可见思考摘要】')) return next;
    next.push({ type: 'text', text: RELAY_VISIBLE_THINKING });
    return next;
  }
  return RELAY_VISIBLE_THINKING.trimStart();
}

function prepareMainChatRequest(url, body, headersInit) {
  const nextBody = { ...body };
  nextBody.system = sanitizeChatSystem(nextBody.system);
  const headers = new Headers(headersInit || undefined);
  const thinkingModel = modelRequestsNativeThinking(nextBody.model);
  // Gemini can return native thinking blocks even when the public model id has no
  // thinking suffix. On main Chat requests, ask the same completion for a visible
  // Chinese summary; the raw block remains private and no Anthropic thinking params
  // are forced onto Gemini relay models.
  const geminiChatModel = isMainChatRequest(url, nextBody) && /gemini/i.test(String(nextBody.model || ''));
  if (thinkingModel || geminiChatModel) {
    nextBody.system = appendRelayThinkingInstruction(nextBody.system);
  }
  if (isOfficialAnthropicUrl(url) && !nextBody.thinking && thinkingModel) {
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
      // Main chat requests can pass through several wrappers before reaching fetch.
      // Apply the final thinking compatibility guard at the provider boundary.
      if (isMainChatRequest(url, body) || (isMessagesEndpoint(url) && modelRequestsNativeThinking(body?.model))) {
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
    if (body?.message === '在云端漫步' && body?.status === 'ok') body = { ...body, thinking_transport: 'native-and-relay-v12' };
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[thinking:transport] health marker unavailable:', error.message);
}

module.exports = { isMainChatRequest, isThinkingDecisionRequest, sanitizeChatSystem, prepareMainChatRequest };
