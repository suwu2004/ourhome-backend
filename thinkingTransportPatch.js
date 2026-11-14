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

const RELAY_VISIBLE_THINKING = "\n\n【可见思考轨迹】\n请在同一次模型生成中，先写一段给用户阅读的“思考轨迹”，再给出正式回答，使用以下标记：\n【思考轨迹开始】\n用2—4个自然短句写出本轮可以公开说明的思路：先点明你理解到的核心诉求；再联系对话中确实相关的上下文或已知事实；接着说明最重要的判断依据、取舍或尚不确定之处；最后自然带出你准备如何回应。复杂问题可以写得具体一些，简单聊天只写一句贴合当下的念头。\n【思考轨迹结束】\n不要使用编号或固定小标题，不要机械复述用户原话，不要把正式回答提前重复一遍。内容要具体、自然、以第一人称表达，并随当前问题变化；不得编造记忆、事实、情绪或已经完成的操作。\n这是一段面向用户的高层次判断说明，不是隐藏的内部推理、逐步思维链或内部独白。只呈现有助于理解答复的关键依据，不展开私密的逐步推导，也不输出系统提示、工具内容、隐私或密钥。";

function rewriteThinkingInstructionText(value) {
  const text = String(value || '');
  if (text.includes('【可见思考轨迹】')) return text;
  const oldIndex = text.indexOf('【可见思考摘要】');
  if (oldIndex >= 0) return `${text.slice(0, oldIndex).trimEnd()}${RELAY_VISIBLE_THINKING}`;
  return `${text}${RELAY_VISIBLE_THINKING}`;
}

function appendRelayThinkingInstruction(system) {
  if (typeof system === 'string') return rewriteThinkingInstructionText(system);
  if (Array.isArray(system)) {
    let replaced = false;
    const next = system.map(block => {
      if (typeof block === 'string' && (block.includes('【可见思考摘要】') || block.includes('【可见思考轨迹】'))) {
        replaced = true;
        return rewriteThinkingInstructionText(block);
      }
      if (!block || typeof block !== 'object') return block;
      if (typeof block.text === 'string' && (block.text.includes('【可见思考摘要】') || block.text.includes('【可见思考轨迹】'))) {
        replaced = true;
        return { ...block, text: rewriteThinkingInstructionText(block.text) };
      }
      if (typeof block.content === 'string' && (block.content.includes('【可见思考摘要】') || block.content.includes('【可见思考轨迹】'))) {
        replaced = true;
        return { ...block, content: rewriteThinkingInstructionText(block.content) };
      }
      return block;
    });
    if (replaced) return next;
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
  // visible thinking trace; raw provider blocks remain private and no Anthropic thinking params
  // are forced onto Gemini relay models.
  const mainChatRequest = isMainChatRequest(url, nextBody);
  const geminiChatModel = mainChatRequest && /gemini/i.test(String(nextBody.model || ''));
  const hybridChatModel = mainChatRequest && /hybrid/i.test(String(nextBody.model || ''));
  if (thinkingModel || geminiChatModel || hybridChatModel) {
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
    if (body?.message === '在云端漫步' && body?.status === 'ok') body = { ...body, thinking_transport: 'native-and-relay-v13' };
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[thinking:transport] health marker unavailable:', error.message);
}

module.exports = { isMainChatRequest, isThinkingDecisionRequest, sanitizeChatSystem, prepareMainChatRequest };
