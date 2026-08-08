'use strict';

const { isMainChatRequest } = require('./intimacyFlowSupport');
const { optimizeVaultTools, appendEconomyRule } = require('./chatToolEconomy');

const previousFetch = globalThis.fetch;

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function vaultEconomyChatFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        if (isMainChatRequest(url, body)) {
          body.tools = optimizeVaultTools(body.tools);
          body.system = appendEconomyRule(body.system);
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch (error) {
        console.warn('[chat:tool-economy] optimization skipped:', error.message);
      }
    }
    return previousFetch(input, init);
  };
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function toolEconomyHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, chat_tool_economy: 'vault-direct-name-v1' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[chat:tool-economy] health marker unavailable:', error.message);
}

module.exports = { optimizeVaultTools, appendEconomyRule };
