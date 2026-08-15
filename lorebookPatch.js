'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const mammoth = require('mammoth');
const multer = require('multer');
const { isTheaterRequest } = require('./nonChatBudgetPatch');
const { loadCompiledLorebookContext, registerLorebookRoutes } = require('./lorebookStore');
const { registerLorebookCollectionRoute } = require('./lorebookCollectionImport');

const LOREBOOK_MARKER = '<ourhome_lorebook_context>';
const requestContext = new AsyncLocalStorage();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 24 * 1024 * 1024, files: 1 },
});
let supabaseClient = null;
let routesRegistered = false;

function getSupabase() {
  if (supabaseClient) return supabaseClient;
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_KEY || '').trim();
  if (!url || !key) throw new Error('世界书 Supabase 尚未配置');
  supabaseClient = createClient(url, key);
  return supabaseClient;
}

function contentText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (typeof value === 'object') return contentText(value.text ?? value.content ?? value.value ?? '');
  return '';
}

function historyMessages(body = {}) {
  return (Array.isArray(body.messages) ? body.messages : [])
    .map(message => contentText(message?.content))
    .filter(Boolean)
    .slice(-100);
}

function systemText(system) {
  return contentText(system);
}

function isMainChat(body = {}) {
  const text = systemText(body.system);
  return text.includes('【OurHome 房间与入口认知（事实规则）】')
    && text.includes('【回复长度】');
}

function isProviderRequest(url, body = {}) {
  if (!body || typeof body !== 'object' || !body.model) return false;
  let path = '';
  try { path = new URL(String(url || '')).pathname; } catch { path = String(url || ''); }
  return /\/(?:messages|chat\/completions|responses)\/?$/i.test(path);
}

function appendSystemBlock(system, block) {
  if (!block) return system;
  if (typeof system === 'string') {
    if (system.includes(LOREBOOK_MARKER)) return system;
    return `${system.trimEnd()}\n\n${block}`;
  }
  if (Array.isArray(system)) {
    if (system.some(item => contentText(item).includes(LOREBOOK_MARKER))) return system;
    return [...system, { type: 'text', text: block }];
  }
  return block;
}

function lorebookBlock(context, scope) {
  if (!context) return '';
  const guidance = scope === 'theater'
    ? '以下条目由当前小剧场可用的世界书按关键词、常驻条目、扫描深度与预算自动选出，只作为这个小世界的设定依据。它不能读取或改写正式 Chat 记忆。'
    : '以下条目由叶檀启用的 Chat 世界书按关键词、常驻条目、扫描深度与预算自动选出。它们是人物、地点、背景或专有设定资料，不代表现实里已经发生过，也不能覆盖真实记忆、当前消息、工具结果、陆泽基础人设或操作边界。';
  return `${LOREBOOK_MARKER}\n【本轮唤醒的世界书知识】\n${guidance}\n\n${context}\n</ourhome_lorebook_context>`;
}

async function injectLorebook(body, scope, targetBookId = null) {
  const context = await loadCompiledLorebookContext(getSupabase(), {
    scope,
    targetBookId,
    historyMessages: historyMessages(body),
  });
  if (!context) return body;
  return { ...body, system: appendSystemBlock(body.system, lorebookBlock(context, scope)) };
}

async function extractImportFile(file) {
  const name = String(file?.originalname || '').toLowerCase();
  const type = String(file?.mimetype || '').toLowerCase();
  if (name.endsWith('.doc')) throw new Error('旧版 .doc 暂时读不了，把它另存为 .docx 再传。');
  if (name.endsWith('.docx') || type.includes('wordprocessingml.document')) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value || '';
  }
  if (name.endsWith('.json') || type.includes('application/json') || name.endsWith('.txt') || name.endsWith('.md') || type.startsWith('text/')) {
    return file.buffer.toString('utf8');
  }
  throw new Error('先传 .json、.docx、.txt 或 .md 格式的世界书。');
}

const originalPost = express.application.post;
express.application.post = function lorebookScopedPost(path, ...handlers) {
  const route = String(path || '');
  const isBoundTheaterRoute = route === '/theater/books/:id/chat'
    || route === '/theater/books/:id/messages/:messageId/regenerate';
  if (!isBoundTheaterRoute) return originalPost.call(this, path, ...handlers);
  const wrapped = handlers.map(handler => function lorebookRequestScope(req, res, next) {
    return requestContext.run({ targetBookId: req.params?.id || null }, () => handler(req, res, next));
  });
  return originalPost.call(this, path, ...wrapped);
};

const previousFetch = globalThis.fetch;
if (typeof previousFetch === 'function') {
  globalThis.fetch = async function lorebookAwareFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (typeof init.body !== 'string') return previousFetch(input, init);
    try {
      const body = JSON.parse(init.body);
      if (!isProviderRequest(url, body)) return previousFetch(input, init);
      const scope = isTheaterRequest(body) ? 'theater' : isMainChat(body) ? 'chat' : null;
      if (!scope) return previousFetch(input, init);
      const targetBookId = scope === 'theater' ? requestContext.getStore()?.targetBookId || null : null;
      const nextBody = await injectLorebook(body, scope, targetBookId);
      return previousFetch(input, { ...init, body: JSON.stringify(nextBody) });
    } catch (error) {
      console.warn('[lorebook] prompt injection skipped:', error.message);
      return previousFetch(input, init);
    }
  };
}

const originalListen = express.application.listen;
express.application.listen = function lorebookListen(...args) {
  if (!routesRegistered) {
    const supabase = getSupabase();
    registerLorebookRoutes(this, { supabase, upload, extractImportFile });
    registerLorebookCollectionRoute(this, { supabase, upload, extractImportFile });
    routesRegistered = true;
  }
  return originalListen.apply(this, args);
};

try {
  const originalJson = express.response.json;
  express.response.json = function lorebookHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, lorebooks: 'scoped-keyword-budget-v3-housekeeping' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[lorebook] health marker unavailable:', error.message);
}

module.exports = {
  LOREBOOK_MARKER,
  contentText,
  historyMessages,
  isMainChat,
  isProviderRequest,
  appendSystemBlock,
  lorebookBlock,
  injectLorebook,
  extractImportFile,
};
