'use strict';

// The memory journal may maintain open-thread metadata every turn, but the user-facing
// Happiness Diary summary must not become an internal transcript such as
// “本轮：……；本轮：……”. Preserve the already-curated day summary and let the nightly
// journal/summary workflow own polished prose.
const previousFetch = globalThis.fetch;

function safeBody(init = {}) {
  if (typeof init?.body !== 'string') return null;
  try { return JSON.parse(init.body); } catch { return null; }
}

function messageText(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map(message => {
      if (typeof message?.content === 'string') return message.content;
      if (!Array.isArray(message?.content)) return '';
      return message.content.map(block => block?.text || '').filter(Boolean).join('\n');
    })
    .join('\n');
}

function isMemoryJournalRequest(body) {
  return Boolean(body?.model)
    && messageText(body?.messages).includes('请为 OurHome 的记忆日志分析刚刚这一轮聊天');
}

function extractExistingSummary(body) {
  const prompt = messageText(body?.messages);
  const start = prompt.indexOf('【今天已有摘要】');
  if (start < 0) return '';
  const rest = prompt.slice(start + '【今天已有摘要】'.length);
  const end = rest.indexOf('【未收尾话题】');
  const value = (end >= 0 ? rest.slice(0, end) : rest).trim();
  return value && value !== '无' ? value.slice(0, 1200) : '';
}

function patchJournalResult(result, existingSummary) {
  if (!result || typeof result !== 'object') return result;
  const next = JSON.parse(JSON.stringify(result));
  if (!next.daily_summary || typeof next.daily_summary !== 'object') next.daily_summary = {};
  next.daily_summary.summary = existingSummary || '';
  return next;
}

function patchProviderPayload(payload, existingSummary) {
  if (!payload || typeof payload !== 'object') return payload;
  const next = JSON.parse(JSON.stringify(payload));
  if (Array.isArray(next.content)) {
    for (const block of next.content) {
      if (!block || typeof block.text !== 'string') continue;
      try {
        block.text = JSON.stringify(patchJournalResult(JSON.parse(block.text), existingSummary));
        return next;
      } catch {}
    }
  }
  if (typeof next.content === 'string') {
    try { next.content = JSON.stringify(patchJournalResult(JSON.parse(next.content), existingSummary)); } catch {}
  }
  return next;
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

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function memoryJournalPresentationFetch(input, init = {}) {
    const body = safeBody(init);
    if (!isMemoryJournalRequest(body)) return previousFetch(input, init);

    const response = await previousFetch(input, init);
    if (!response?.ok) return response;
    try {
      const payload = await response.clone().json();
      return jsonResponseLike(response, patchProviderPayload(payload, extractExistingSummary(body)));
    } catch (error) {
      console.warn('[memory:journal-display] response patch skipped:', error.message);
      return response;
    }
  };
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function memoryJournalPresentationHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, memory_journal_presentation: 'display-summary-isolation-v1' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[memory:journal-display] health marker unavailable:', error.message);
}

module.exports = {
  isMemoryJournalRequest,
  extractExistingSummary,
  patchJournalResult,
  patchProviderPayload,
};
