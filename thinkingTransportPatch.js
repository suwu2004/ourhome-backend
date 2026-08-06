// Preload compatibility layer for OurHome chat thinking.
// Every chat turn keeps a visible "想了想": native reasoning is preferred;
// models without native reasoning fall back to the <thinking> block requested
// by promptRules.js.

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

function stripLegacyInnerMonologue(value) {
  return String(value || '')
    .replace(/\n*【可见的内心独白】[\s\S]*$/u, '')
    .trimEnd();
}

function sanitizeChatSystem(system) {
  if (typeof system === 'string') return stripLegacyInnerMonologue(system);
  if (!Array.isArray(system)) return system;
  return system.map(block => {
    if (typeof block === 'string') return stripLegacyInnerMonologue(block);
    if (!block || typeof block !== 'object') return block;
    if (typeof block.text === 'string') return { ...block, text: stripLegacyInnerMonologue(block.text) };
    if (typeof block.content === 'string') return { ...block, content: stripLegacyInnerMonologue(block.content) };
    return block;
  });
}

function isMainChatRequest(url, body) {
  if (!/\/messages(?:\?|$)/i.test(String(url || ''))) return false;
  return systemText(body?.system).includes('【每轮可见思考】');
}

function isThinkingDecisionRequest(url, body) {
  if (!/\/messages(?:\?|$)/i.test(String(url || ''))) return false;
  const text = messageText(body?.messages);
  return Number(body?.max_tokens || 0) <= 20
    && text.includes('只回答一个词')
    && text.includes('想 或者 不想');
}

function shouldEnableNativeThinking(body) {
  const model = String(body?.model || '').toLowerCase();
  return model.includes('claude') && model.includes('thinking');
}

function fixedThinkResponse() {
  return new Response(JSON.stringify({
    id: 'ourhome-always-think',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: '想' }],
    stop_reason: 'end_turn',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

if (typeof originalFetch === 'function') {
  globalThis.fetch = async function patchedFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body);

        // server.js 旧代码仍保留一次“想/不想”判断。这里直接固定为“想”，
        // 不再请求上游，也不再让某一轮因为判断结果而没有思考。
        if (isThinkingDecisionRequest(url, body)) {
          return fixedThinkResponse();
        }

        if (isMainChatRequest(url, body)) {
          // 清掉旧版长篇独白提示，保留 promptRules.js 中统一的每轮可见思考规则。
          body.system = sanitizeChatSystem(body.system);

          const headers = new Headers(init.headers || undefined);
          if (shouldEnableNativeThinking(body)) {
            const maxTokens = Number(body.max_tokens) || 0;
            const safeBudget = Math.max(1024, Math.min(6000, maxTokens > 1400 ? maxTokens - 800 : 1024));
            body.thinking = { type: 'enabled', budget_tokens: safeBudget };
            body.temperature = 1;
            headers.set('anthropic-beta', 'interleaved-thinking-2025-05-14');
            console.log(`[thinking:relay] native reasoning enabled model=${body.model} budget=${safeBudget}`);
          }

          init = {
            ...init,
            headers,
            body: JSON.stringify(body),
          };
        }
      } catch (error) {
        console.warn('[thinking:relay] request patch skipped:', error.message);
      }
    }
    return originalFetch(input, init);
  };
}

// Public marker for confirming which thinking transport is live on Render.
try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function patchedJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = {
        ...body,
        thinking_transport: 'native-first-always-visible-v3',
      };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[thinking:relay] health marker unavailable:', error.message);
}
