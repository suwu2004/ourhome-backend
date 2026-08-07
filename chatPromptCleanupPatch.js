'use strict';

const { isMainChatRequest } = require('./intimacyFlowSupport');
const { cleanupSystem } = require('./chatPromptCleanup');

const previousFetch = globalThis.fetch;

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function personaFirstChatFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;

    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        if (isMainChatRequest(url, body)) {
          body.system = cleanupSystem(body.system);
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch (error) {
        console.warn('[chat:persona-first] prompt cleanup skipped:', error.message);
      }
    }

    return previousFetch(input, init);
  };
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function personaFirstHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, chat_prompt_cleanup: 'persona-first-v1' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[chat:persona-first] health marker unavailable:', error.message);
}

module.exports = { cleanupSystem };
