'use strict';

const { isMainChatRequest } = require('./intimacyFlowSupport');
const { MAX_MAIN_CHAT_PAYLOAD_CHARS, serializedLength, payloadComponentChars, trimOldHistory } = require('./mainChatPayloadBudget');

const previousFetch = globalThis.fetch;
const CHAT_PURPOSES = new Set(['chat', 'chat-empty-recovery']);

function requestUrl(input) {
  return typeof input === 'string' || input instanceof URL
    ? String(input)
    : String(input?.url || '');
}

function requestPurpose(init = {}) {
  try {
    return String(new Headers(init?.headers || undefined).get('X-OurHome-Call-Purpose') || '').trim();
  } catch {
    return '';
  }
}

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function finalChatPayloadBudgetFetch(input, init = {}) {
    const url = requestUrl(input);
    if (typeof init?.body !== 'string' || !/messages(?:\?|$)/i.test(url)) {
      return previousFetch(input, init);
    }

    const purpose = requestPurpose(init);
    if (!CHAT_PURPOSES.has(purpose)) return previousFetch(input, init);

    try {
      const body = JSON.parse(init.body);
      if (!body?.model || !isMainChatRequest(url, body)) return previousFetch(input, init);

      const nextBody = trimOldHistory(body, MAX_MAIN_CHAT_PAYLOAD_CHARS);
      const finalChars = serializedLength(nextBody);
      if (finalChars > MAX_MAIN_CHAT_PAYLOAD_CHARS) {
        const parts = payloadComponentChars(nextBody);
        console.warn(
          `[chat:final-budget:breakdown] model=${String(body.model).slice(0, 100)} total=${parts.totalChars} system=${parts.systemChars} tools=${parts.toolsChars} messages=${parts.messagesChars} messageCount=${parts.messageCount} toolCount=${parts.toolCount} cap=${MAX_MAIN_CHAT_PAYLOAD_CHARS}`,
        );
      }
      if (nextBody !== body) {
        return previousFetch(input, { ...init, body: JSON.stringify(nextBody) });
      }
    } catch (error) {
      console.warn('[chat:final-budget] request patch skipped:', error.message);
    }

    return previousFetch(input, init);
  };
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function finalChatPayloadBudgetHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, final_chat_payload_budget: '38k-after-ledger-v1' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[chat:final-budget] health marker unavailable:', error.message);
}

module.exports = { requestPurpose };
