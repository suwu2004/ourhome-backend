'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { createClient } = require('@supabase/supabase-js');
const { isMainChatRequest } = require('./intimacyFlowSupport');
const {
  LEDGER_MAX_CHUNKS_PER_TURN,
  LEDGER_RETRY_MS,
  rowsChars,
  overflowRows,
  rowsAfterCursor,
  splitRowsIntoChunks,
  shouldRefreshLedger,
  buildLedgerUpdatePrompt,
  buildLedgerBlock,
  injectLedger,
  providerText,
  normalizeLedgerSummary,
} = require('./contextLedgerSupport');

const previousFetch = globalThis.fetch;
const ledgerContext = new AsyncLocalStorage();
const TARGET_ROUTES = new Set([
  '/chat',
  '/chat/regenerate',
  '/messages/:id/edit-and-regenerate',
  '/messages/:id/rollback',
  '/messages/:id/rollback/undo',
]);
const SETTINGS_CACHE_MS = 20_000;
const HISTORY_PAGE_SIZE = 1000;

const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const supabaseKey = process.env.SUPABASE_KEY || '';
const supabase = supabaseUrl && supabaseKey && typeof previousFetch === 'function'
  ? createClient(supabaseUrl, supabaseKey, {
      global: { fetch: previousFetch },
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

let settingsCache = null;
let settingsCacheAt = 0;

function safeId(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function loadLedgerSettings() {
  if (!supabase) return { maxContextRounds: 20 };
  const now = Date.now();
  if (settingsCache && now - settingsCacheAt < SETTINGS_CACHE_MS) return settingsCache;
  const { data, error } = await supabase.from('settings')
    .select('max_context_rounds')
    .eq('session_id', 'global')
    .maybeSingle();
  if (error) throw error;
  settingsCache = {
    maxContextRounds: Math.max(1, Math.min(500, Number(data?.max_context_rounds) || 20)),
  };
  settingsCacheAt = now;
  return settingsCache;
}

async function sessionForMessage(messageId) {
  if (!supabase || !messageId) return null;
  const { data, error } = await supabase.from('messages')
    .select('session_id')
    .eq('id', messageId)
    .maybeSingle();
  if (error) throw error;
  return safeId(data?.session_id);
}

async function resolveRouteContext(route, req) {
  let sessionId = safeId(req.body?.session_id);
  if (!sessionId && req.params?.id) sessionId = await sessionForMessage(safeId(req.params.id));
  return {
    route,
    sessionId,
    resetMode: route === '/messages/:id/rollback' || route === '/messages/:id/rollback/undo',
    prepared: false,
    block: '',
  };
}

async function resetLedger(sessionId) {
  if (!supabase || !sessionId) return;
  const { error } = await supabase.from('session_context_ledgers').delete().eq('session_id', sessionId);
  if (error) throw error;
  console.log(`[context:ledger] reset session=${sessionId}`);
}

function installExpressContextBridge() {
  let express;
  try {
    express = require('express');
  } catch (error) {
    console.warn('[context:ledger] express context unavailable:', error.message);
    return;
  }
  if (express.application.__ourhomeContextLedgerInstalled) return;
  express.application.__ourhomeContextLedgerInstalled = true;
  const originalPost = express.application.post;
  express.application.post = function contextLedgerAwarePost(path, ...handlers) {
    const route = typeof path === 'string' ? path : '';
    if (!TARGET_ROUTES.has(route)) return originalPost.call(this, path, ...handlers);
    const index = handlers.findIndex(handler => typeof handler === 'function');
    if (index < 0) return originalPost.call(this, path, ...handlers);
    const originalHandler = handlers[index];
    handlers[index] = async function contextLedgerRoute(req, res, next) {
      try {
        const ctx = await resolveRouteContext(route, req);
        if (ctx.resetMode && ctx.sessionId) await resetLedger(ctx.sessionId);
        return ledgerContext.run(ctx, () => originalHandler(req, res, next));
      } catch (error) {
        console.warn('[context:ledger] route context skipped:', error.message);
        return originalHandler(req, res, next);
      }
    };
    return originalPost.call(this, path, ...handlers);
  };
}

async function loadVisibleHistory(sessionId) {
  if (!supabase || !sessionId) return [];
  const rows = [];
  for (let offset = 0; ; offset += HISTORY_PAGE_SIZE) {
    const { data, error } = await supabase.from('messages')
      .select('id,role,content,attachment_summary,created_at')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + HISTORY_PAGE_SIZE - 1);
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < HISTORY_PAGE_SIZE) break;
  }
  return rows;
}

async function readLedger(sessionId) {
  if (!supabase || !sessionId) return null;
  const { data, error } = await supabase.from('session_context_ledgers')
    .select('*')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function commitLedger({ sessionId, expectedVersion, summary, cursorId, count, chars, retryAfter = null, errorText = null }) {
  if (!supabase || !sessionId) return null;
  const { data, error } = await supabase.rpc('ourhome_context_ledger_commit', {
    p_session_id: sessionId,
    p_expected_version: Number(expectedVersion) || 0,
    p_summary: summary || '',
    p_summarized_through_message_id: cursorId || null,
    p_summarized_message_count: Math.max(0, Number(count) || 0),
    p_summarized_chars: Math.max(0, Number(chars) || 0),
    p_retry_after: retryAfter,
    p_last_error: errorText || null,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data[0] || null) : data;
}

async function generateLedgerSummary(url, init, mainBody, existingSummary, chunkRows, coveredBefore) {
  const prompt = buildLedgerUpdatePrompt(existingSummary, chunkRows, { coveredBefore });
  const model = String(process.env.CONTEXT_LEDGER_MODEL || mainBody?.model || '').trim();
  if (!model) throw new Error('没有可用于账本整理的模型');
  const body = {
    model,
    max_tokens: 1800,
    temperature: 0.2,
    system: '你只负责维护隐藏的聊天接续账本。严格依据给出的旧聊天整理事实，不虚构，不输出对话回复，不输出思考过程。',
    messages: [{ role: 'user', content: prompt }],
  };
  const headers = new Headers(init?.headers || undefined);
  headers.delete('content-length');
  headers.delete('anthropic-beta');
  const response = await previousFetch(url, {
    ...init,
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`账本模型返回 ${response.status}`);
  const payload = await response.json();
  const summary = normalizeLedgerSummary(providerText(payload));
  if (!summary) throw new Error('账本模型返回空内容');
  return summary;
}

function retryBlocked(ledger) {
  const retryAt = ledger?.retry_after ? new Date(ledger.retry_after).getTime() : 0;
  return Number.isFinite(retryAt) && retryAt > Date.now();
}

async function prepareLedger(ctx, url, init, body) {
  if (!ctx?.sessionId) return body;
  if (ctx.prepared) return injectLedger(body, ctx.block);
  ctx.prepared = true;

  const settings = await loadLedgerSettings();
  const recentKeep = Math.max(2, settings.maxContextRounds * 2);
  const history = await loadVisibleHistory(ctx.sessionId);
  const overflow = overflowRows(history, recentKeep);
  if (!overflow.length) return body;

  let ledger = await readLedger(ctx.sessionId);
  let cursorId = safeId(ledger?.summarized_through_message_id);
  let coveredCount = Math.max(0, Number(ledger?.summarized_message_count) || 0);
  let coveredChars = Math.max(0, Number(ledger?.summarized_chars) || 0);
  let summary = ledger?.summary || '';
  let pending = rowsAfterCursor(overflow, cursorId);

  if (shouldRefreshLedger(ledger, pending) && !retryBlocked(ledger)) {
    const chunks = splitRowsIntoChunks(pending).slice(0, LEDGER_MAX_CHUNKS_PER_TURN);
    try {
      for (const chunk of chunks) {
        const nextSummary = await generateLedgerSummary(url, init, body, summary, chunk, coveredCount);
        const last = chunk[chunk.length - 1];
        const nextCount = coveredCount + chunk.length;
        const nextChars = coveredChars + rowsChars(chunk);
        const committed = await commitLedger({
          sessionId: ctx.sessionId,
          expectedVersion: Number(ledger?.version) || 0,
          summary: nextSummary,
          cursorId: safeId(last?.id),
          count: nextCount,
          chars: nextChars,
        });
        if (!committed) {
          ledger = await readLedger(ctx.sessionId);
          summary = ledger?.summary || summary;
          cursorId = safeId(ledger?.summarized_through_message_id) || cursorId;
          coveredCount = Math.max(coveredCount, Number(ledger?.summarized_message_count) || 0);
          coveredChars = Math.max(coveredChars, Number(ledger?.summarized_chars) || 0);
          break;
        }
        ledger = committed;
        summary = committed.summary || nextSummary;
        cursorId = safeId(committed.summarized_through_message_id) || safeId(last?.id);
        coveredCount = Number(committed.summarized_message_count) || nextCount;
        coveredChars = Number(committed.summarized_chars) || nextChars;
      }
      console.log(`[context:ledger] session=${ctx.sessionId} covered=${coveredCount}/${overflow.length}`);
    } catch (error) {
      const retryAfter = new Date(Date.now() + LEDGER_RETRY_MS).toISOString();
      try {
        const failed = await commitLedger({
          sessionId: ctx.sessionId,
          expectedVersion: Number(ledger?.version) || 0,
          summary,
          cursorId,
          count: coveredCount,
          chars: coveredChars,
          retryAfter,
          errorText: error.message,
        });
        if (failed) ledger = failed;
      } catch (commitError) {
        console.warn('[context:ledger] failed to save retry marker:', commitError.message);
      }
      console.warn(`[context:ledger] refresh delayed session=${ctx.sessionId}:`, error.message);
    }
  }

  pending = rowsAfterCursor(overflow, cursorId);
  ctx.block = buildLedgerBlock({
    summary,
    bridgeRows: pending,
    coveredCount,
    overflowCount: overflow.length,
  });
  return injectLedger(body, ctx.block);
}

installExpressContextBridge();

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function contextLedgerFetch(input, init = {}) {
    const ctx = ledgerContext.getStore();
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (ctx?.sessionId && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        if (isMainChatRequest(url, body)) {
          const nextBody = await prepareLedger(ctx, url, init, body);
          init = { ...init, body: JSON.stringify(nextBody) };
        }
      } catch (error) {
        console.warn('[context:ledger] request patch skipped:', error.message);
      }
    }
    return previousFetch(input, init);
  };
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function contextLedgerHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, context_ledger: 'rolling-precompact-v1' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[context:ledger] health marker unavailable:', error.message);
}

module.exports = {
  loadVisibleHistory,
  readLedger,
  commitLedger,
  prepareLedger,
};