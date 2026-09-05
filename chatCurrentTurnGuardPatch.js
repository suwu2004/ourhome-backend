'use strict';

const { isMainChatRequest } = require('./intimacyFlowSupport');
const { appendContextBoundary } = require('./chatContextBoundary');

const previousFetch = globalThis.fetch;

function guardCurrentTurn(body = {}) {
  if (!body || typeof body !== 'object') return body;
  return { ...body, system: appendContextBoundary(body.system) };
}

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function currentTurnGuardFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (typeof init?.body !== 'string') return previousFetch(input, init);
    try {
      const body = JSON.parse(init.body);
      if (isMainChatRequest(url, body)) {
        return previousFetch(input, { ...init, body: JSON.stringify(guardCurrentTurn(body)) });
      }
    } catch (error) {
      console.warn('[chat:current-turn] request guard skipped:', error.message);
    }
    return previousFetch(input, init);
  };
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function currentTurnGuardHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, chat_current_turn: 'latest-user-wins-v1' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[chat:current-turn] health marker unavailable:', error.message);
}

module.exports = { guardCurrentTurn };
