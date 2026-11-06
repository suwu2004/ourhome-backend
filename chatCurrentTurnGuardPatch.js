'use strict';

// Main Chat carries several useful background blocks (today summary, open threads,
// long memories, rolling ledger). They are context, never the message that is being
// answered right now. A stale/repeated daily-summary line must not outrank the final
// user turn in the provider message array.
const { isMainChatRequest } = require('./intimacyFlowSupport');

const previousFetch = globalThis.fetch;
const MARKER = '<ourhome_current_turn_guard>';
const GUARD = `${MARKER}\\n【当前轮与接话连续性优先级】\\nmessages 数组里最后一条 user 消息才是这一轮正在处理的输入。当前对话原文优先于窗口简介、今日摘要、临时记忆、长期记忆和隐藏接续账本；这些资料只能补充背景，不能覆盖或重写刚发生的对话。\\n当叶檀说“吃饱了、吃完了、喝完了、到家了、下课了、弄好了、继续”等承接句时，必须先回看 messages 中紧邻的原始对话，沿用已经明确出现的对象、事实和进度，不要再次询问她刚刚已经回答过的信息。若前文已经说明吃了什么、做了什么、去了哪里或正在处理什么，应直接自然承接。\\n用户明确纠正过的事实优先于陆泽先前的猜测；新确认的事实优先于旧摘要中的过时描述。助手自己的猜测不得升级成用户事实。只有原始对话确实没有提供答案时，才询问缺失信息。\\n不要因为历史材料重复出现就回复上一轮，也不要把摘要里的旧计划误认为当前正在执行。\\n</ourhome_current_turn_guard>`;

function requestPurpose(init = {}) {
  try {
    return String(new Headers(init?.headers || undefined).get('X-OurHome-Call-Purpose') || '').trim();
  } catch {
    return '';
  }
}

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
