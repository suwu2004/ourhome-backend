// Preload compatibility layer for OurHome chat thinking.
// Chat reply style rules stay minimal; visible thinking is handled separately here.
// Native reasoning is preferred. When an upstream provider returns no reasoning and
// ignores the requested <thinking> block, a second lightweight model call creates
// the visible thought so the “想了想” area is never empty.

const { extractThinkingText } = require('./thinkingSupport');
const {
  extractResponseText,
  normalizeVisibleThought,
  buildFallbackRequestBody,
  deterministicFallbackThought,
  injectReasoningContent,
} = require('./visibleThinkingFallback');

const originalFetch = globalThis.fetch;

const VISIBLE_THINKING_PROTOCOL = `【可见思考协议】
每一轮聊天都要保留可见思考，不再判断这一轮是否需要思考。
如果接口单独返回 reasoning、reasoning_content、thinking 或 analysis 等原生思考字段，系统会优先读取并展示原生内容。
如果接口没有返回原生思考字段，请在正式回复之前输出一个完整的 <thinking> 与 </thinking> 标签块，写下自然、连续的可见思考。简单问候或直白话题可以很短；复杂问题可以自然展开。
不要把正式回复复制进 thinking，不要为了长度机械重复。结束 </thinking> 后另起一段给出正式回复。`;

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
    .replace(/\n*【每轮可见思考】[\s\S]*$/u, '')
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

function appendVisibleThinkingProtocol(system) {
  if (systemText(system).includes('【可见思考协议】')) return system;
  if (typeof system === 'string') {
    return `${system.trimEnd()}\n\n${VISIBLE_THINKING_PROTOCOL}`;
  }
  if (Array.isArray(system)) {
    return [...system, { type: 'text', text: VISIBLE_THINKING_PROTOCOL }];
  }
  return VISIBLE_THINKING_PROTOCOL;
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

function jsonResponseLike(response, payload) {
  const headers = new Headers(response.headers || undefined);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function guaranteeVisibleThinking(response, url, init, mainBody) {
  if (!response?.ok || !mainBody) return response;

  let payload;
  try {
    payload = await response.clone().json();
  } catch (error) {
    console.warn('[thinking:fallback] primary response is not JSON:', error.message);
    return response;
  }

  const nativeOrTaggedThinking = extractThinkingText(payload);
  if (nativeOrTaggedThinking) return response;

  const replyText = extractResponseText(payload);
  let fallbackThought = '';

  try {
    const fallbackBody = buildFallbackRequestBody(mainBody, replyText);
    const headers = new Headers(init?.headers || undefined);
    headers.delete('content-length');
    headers.delete('anthropic-beta');

    const fallbackResponse = await originalFetch(url, {
      ...init,
      headers,
      body: JSON.stringify(fallbackBody),
    });

    if (fallbackResponse.ok) {
      const fallbackPayload = await fallbackResponse.json();
      fallbackThought = normalizeVisibleThought(
        extractResponseText(fallbackPayload) || extractThinkingText(fallbackPayload),
      );
    } else {
      console.warn(`[thinking:fallback] visible thought request failed status=${fallbackResponse.status}`);
    }
  } catch (error) {
    console.warn('[thinking:fallback] visible thought request failed:', error.message);
  }

  if (!fallbackThought) {
    fallbackThought = deterministicFallbackThought(mainBody.messages);
  }

  console.log(`[thinking:fallback] injected visible thought chars=${fallbackThought.length} model=${mainBody.model || ''}`);
  return jsonResponseLike(response, injectReasoningContent(payload, fallbackThought));
}

if (typeof originalFetch === 'function') {
  globalThis.fetch = async function patchedFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    let mainBody = null;

    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body);

        // server.js 旧代码仍保留一次“想/不想”判断。这里直接固定为“想”，
        // 不再请求上游，也不再让某一轮因为判断结果而没有思考。
        if (isThinkingDecisionRequest(url, body)) {
          return fixedThinkResponse();
        }

        if (isMainChatRequest(url, body)) {
          // 回复风格提示词保持精简；思考输出协议由独立兼容层追加。
          body.system = appendVisibleThinkingProtocol(sanitizeChatSystem(body.system));
          mainBody = body;

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

    const response = await originalFetch(input, init);
    return guaranteeVisibleThinking(response, url, init, mainBody);
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
        thinking_transport: 'guaranteed-visible-thinking-v5',
      };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[thinking:relay] health marker unavailable:', error.message);
}
