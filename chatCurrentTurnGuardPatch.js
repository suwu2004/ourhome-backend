'use strict';

// Main Chat carries several useful background blocks (today summary, open threads,
// long memories, rolling ledger). They are context, never the message that is being
// answered right now. A stale/repeated daily-summary line must not outrank the final
// user turn in the provider message array.
const { isMainChatRequest } = require('./intimacyFlowSupport');

const previousFetch = globalThis.fetch;
const MARKER = '<ourhome_current_turn_guard>';
const GUARD = `${MARKER}\n【当前轮优先级】\nmessages 数组里最后一条 user 消息（或工具回传）才是这一轮正在处理的当前输入。系统提示中的“今日摘要”“今日重点”“未完待续”、长期记忆、隐藏接续账本和其他历史材料都只是背景资料，绝不能当成叶檀刚刚又发了一遍的话，也不能因为历史材料重复出现就去回复上一轮。若背景与当前最后一条 user 消息在话题或时序上冲突，始终以当前最后一条 user 消息为准；只有当前消息明确接续旧话题时，才自然调用对应背景。\n</ourhome_current_turn_guard>`;

function appendGuard(system) {
  if (typeof system === 'string') {
    if (system.includes(MARKER)) return system;
    return `${system.trimEnd()}\n\n${GUARD}`;
  }
  if (Array.isArray(system)) {
    const exists = system.some(block => String(typeof block === 'string' ? block : block?.text || block?.content || '').includes(MARKER));
    if (exists) return system;
    return [...system, { type: 'text', text: GUARD }];
  }
  return GUARD;
}

function guardCurrentTurn(body = {}) {
  if (!body || typeof body !== 'object') return body;
  return { ...body, system: appendGuard(body.system) };
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

module.exports = { MARKER, GUARD, appendGuard, guardCurrentTurn };
