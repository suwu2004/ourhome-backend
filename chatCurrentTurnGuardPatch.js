'use strict';

// Main Chat carries several useful background blocks (today summary, open threads,
// long memories, rolling ledger). They are context, never the message that is being
// answered right now. A stale/repeated daily-summary line must not outrank the final
// user turn in the provider message array.
const { isMainChatRequest } = require('./intimacyFlowSupport');
const { MARKER, RULE, appendContextBoundary } = require('./chatContextBoundary');

const previousFetch = globalThis.fetch;
const GUARD = RULE;

function requestPurpose(init = {}) {
  try {
    return String(new Headers(init?.headers || undefined).get('X-OurHome-Call-Purpose') || '').trim();
  } catch {
    return '';
  }
}

function appendGuard(system) {
  return appendContextBoundary(system);
}

function guardCurrentTurn(body = {}) {
  if (!body || typeof body !== 'object') return body;
  return { ...body, system: appendGuard(body.system) };
}

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function currentTurnGuardFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    // Ledger summarization is a maintenance request, not a live user turn.
    if (requestPurpose(init) === 'context-ledger') return previousFetch(input, init);
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
      body = { ...body, chat_current_turn: 'latest-user-continuity-v2' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[chat:current-turn] health marker unavailable:', error.message);
}

module.exports = { MARKER, GUARD, appendGuard, guardCurrentTurn };
