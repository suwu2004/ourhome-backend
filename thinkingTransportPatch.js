// Preload compatibility layer for Claude-style relay endpoints.
// It keeps native reasoning available for reply quality while the chat UI only
// receives the concise, explicitly generated <thinking> summary.

const originalFetch = globalThis.fetch;

function systemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map(block => typeof block === 'string' ? block : block?.text || block?.content || '')
    .filter(Boolean)
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

function shouldEnableNativeThinking(body) {
  const model = String(body?.model || '').toLowerCase();
  return model.includes('claude') && model.includes('thinking');
}

if (typeof originalFetch === 'function') {
  globalThis.fetch = async function patchedFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        if (isMainChatRequest(url, body)) {
          // The main server still appends an older long-form inner-monologue
          // fallback for relays. The newer prompt already requests a concise,
          // user-facing summary, so remove the conflicting legacy block.
          body.system = sanitizeChatSystem(body.system);

          const headers = new Headers(init.headers || undefined);
          if (shouldEnableNativeThinking(body)) {
            const maxTokens = Number(body.max_tokens) || 0;
            const safeBudget = Math.max(1024, Math.min(3000, maxTokens > 1200 ? maxTokens - 800 : 1024));
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

// A public readiness marker makes it possible to verify that Render is running
// the current thinking transport without exposing settings or credentials.
try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function patchedJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = {
        ...body,
        thinking_transport: 'relay-native-summary-v2',
      };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[thinking:relay] health marker unavailable:', error.message);
}
