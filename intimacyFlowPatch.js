'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { createClient } = require('@supabase/supabase-js');
const {
  normalizeConfig,
  latestUserText,
  isBoundaryStopText,
  isMainChatRequest,
  parseTrailingControl,
  sanitizeControlText,
  sanitizeProviderPayload,
  responseText,
  hasToolUse,
  inactiveState,
  nextGuide,
  injectPrivateGuidance,
} = require('./intimacyFlowSupport');

const previousFetch = globalThis.fetch;
const flowContext = new AsyncLocalStorage();
const CONFIG_CACHE_MS = 20_000;
const TARGET_ROUTES = new Set([
  '/chat',
  '/chat/regenerate',
  '/messages/:id/edit-and-regenerate',
  '/messages/:id/rollback',
  '/messages/:id/rollback/undo',
]);

const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const supabaseKey = process.env.SUPABASE_KEY || '';
const supabase = supabaseUrl && supabaseKey && typeof previousFetch === 'function'
  ? createClient(supabaseUrl, supabaseKey, {
      global: { fetch: previousFetch },
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

let configCache = null;
let configCacheAt = 0;

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
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

function sanitizeReasoningFields(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const next = sanitizeProviderPayload(payload);
  for (const key of ['reasoning_content', 'reasoning', 'thinking', 'analysis']) {
    if (typeof next?.[key] === 'string') next[key] = sanitizeControlText(next[key]);
  }
  if (Array.isArray(next?.content)) {
    next.content = next.content.map(block => {
      if (!block || typeof block !== 'object') return block;
      if (typeof block.thinking === 'string') return { ...block, thinking: sanitizeControlText(block.thinking) };
      if (typeof block.reasoning === 'string') return { ...block, reasoning: sanitizeControlText(block.reasoning) };
      return block;
    });
  }
  return next;
}

async function loadConfig() {
  if (!supabase) return normalizeConfig({ enabled: false });
  const now = Date.now();
  if (configCache && now - configCacheAt < CONFIG_CACHE_MS) return configCache;
  const { data, error } = await supabase.from('intimacy_flow_configs')
    .select('config')
    .eq('id', 'global')
    .maybeSingle();
  if (error) throw error;
  configCache = normalizeConfig(data?.config || { enabled: false });
  configCacheAt = now;
  return configCache;
}

async function readState(sessionId) {
  if (!supabase || !sessionId) return { version: 0, state: inactiveState() };
  const { data, error } = await supabase.from('intimacy_flow_states')
    .select('version,state')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error) throw error;
  return data
    ? { version: Number(data.version) || 0, state: data.state || inactiveState() }
    : { version: 0, state: inactiveState() };
}

async function transitionState(sessionId, expectedVersion, nextStateValue) {
  if (!supabase || !sessionId) return null;
  const { data, error } = await supabase.rpc('ourhome_intimacy_transition', {
    p_session_id: sessionId,
    p_expected_version: Number(expectedVersion) || 0,
    p_next_state: nextStateValue || inactiveState(),
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    sessionId: safeNumber(row.session_id) || sessionId,
    version: Number(row.version) || 0,
    state: row.state || inactiveState(),
  };
}

async function readTurnSnapshot(userMessageId) {
  if (!supabase || !userMessageId) return null;
  const { data, error } = await supabase.from('intimacy_flow_turn_snapshots')
    .select('snapshot')
    .eq('user_message_id', userMessageId)
    .maybeSingle();
  if (error) throw error;
  return data?.snapshot || null;
}

async function saveTurnSnapshot(userMessageId, sessionId, appliedGuide) {
  if (!supabase || !userMessageId || !sessionId) return;
  const { error } = await supabase.from('intimacy_flow_turn_snapshots').upsert({
    user_message_id: userMessageId,
    session_id: sessionId,
    snapshot: {
      schemaVersion: 1,
      appliedGuide: appliedGuide || null,
      savedAt: Date.now(),
    },
  }, { onConflict: 'user_message_id' });
  if (error) throw error;
}

async function latestVisibleUserMessageId(sessionId) {
  if (!supabase || !sessionId) return null;
  const { data, error } = await supabase.from('messages')
    .select('id')
    .eq('session_id', sessionId)
    .eq('role', 'user')
    .eq('visible', true)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return safeNumber(data?.id);
}

async function sessionForMessage(messageId) {
  if (!supabase || !messageId) return null;
  const { data, error } = await supabase.from('messages')
    .select('session_id,role')
    .eq('id', messageId)
    .maybeSingle();
  if (error) throw error;
  return data ? { sessionId: safeNumber(data.session_id), role: data.role } : null;
}

async function resolveRouteContext(route, req) {
  let sessionId = safeNumber(req.body?.session_id);
  let targetUserMessageId = null;
  const messageId = safeNumber(req.params?.id);
  if (!sessionId && messageId) {
    const source = await sessionForMessage(messageId);
    sessionId = source?.sessionId || null;
    if (source?.role === 'user') targetUserMessageId = messageId;
  }
  const rewriteMode = route === '/chat/regenerate' || route === '/messages/:id/edit-and-regenerate';
  const rollbackMode = route === '/messages/:id/rollback' || route === '/messages/:id/rollback/undo';
  return {
    route,
    sessionId,
    targetUserMessageId,
    rewriteMode,
    rollbackMode,
    requestMessage: String(req.body?.message || req.body?.content || ''),
    prepared: false,
    config: null,
    appliedGuide: null,
    userMessageId: targetUserMessageId,
    stateVersion: null,
    transitionDone: false,
    suppressStart: false,
  };
}

async function resetFlowForRollback(ctx) {
  if (!ctx?.sessionId) return;
  try {
    const current = await readState(ctx.sessionId);
    await transitionState(ctx.sessionId, current.version, inactiveState());
    console.log(`[intimacy:flow] rollback reset session=${ctx.sessionId}`);
  } catch (error) {
    console.warn('[intimacy:flow] rollback reset skipped:', error.message);
  }
}

function installExpressContextBridge() {
  let express;
  try {
    express = require('express');
  } catch (error) {
    console.warn('[intimacy:flow] express context unavailable:', error.message);
    return;
  }
  if (express.application.__ourhomeIntimacyContextInstalled) return;
  express.application.__ourhomeIntimacyContextInstalled = true;
  const originalPost = express.application.post;
  express.application.post = function intimacyAwarePost(path, ...handlers) {
    const route = typeof path === 'string' ? path : '';
    if (!TARGET_ROUTES.has(route)) return originalPost.call(this, path, ...handlers);
    const firstHandlerIndex = handlers.findIndex(handler => typeof handler === 'function');
    if (firstHandlerIndex < 0) return originalPost.call(this, path, ...handlers);
    const originalHandler = handlers[firstHandlerIndex];
    handlers[firstHandlerIndex] = async function intimacyRouteContext(req, res, next) {
      try {
        const ctx = await resolveRouteContext(route, req);
        if (ctx.rollbackMode) await resetFlowForRollback(ctx);
        return flowContext.run(ctx, () => originalHandler(req, res, next));
      } catch (error) {
        console.warn('[intimacy:flow] route context skipped:', error.message);
        return originalHandler(req, res, next);
      }
    };
    return originalPost.call(this, path, ...handlers);
  };
}

async function ensureUserMessageId(ctx) {
  if (ctx.userMessageId) return ctx.userMessageId;
  ctx.userMessageId = await latestVisibleUserMessageId(ctx.sessionId);
  return ctx.userMessageId;
}

async function prepareGuidance(ctx, body) {
  if (!ctx?.sessionId) return body;
  if (ctx.prepared) return injectPrivateGuidance(body, ctx.config, ctx.appliedGuide);

  ctx.config = await loadConfig();
  ctx.prepared = true;
  if (!ctx.config.enabled || !ctx.config.flow.enabled) return body;

  const userMessageId = await ensureUserMessageId(ctx);
  const current = await readState(ctx.sessionId);
  ctx.stateVersion = current.version;
  const userText = latestUserText(body.messages);

  if (isBoundaryStopText(userText) && current.state?.flow?.active) {
    const stopped = await transitionState(ctx.sessionId, current.version, inactiveState());
    if (stopped) ctx.stateVersion = stopped.version;
    ctx.suppressStart = true;
    ctx.appliedGuide = null;
    if (userMessageId) await saveTurnSnapshot(userMessageId, ctx.sessionId, null);
    console.log(`[intimacy:flow] boundary stop session=${ctx.sessionId}`);
    return body;
  }

  if (ctx.rewriteMode && userMessageId) {
    const saved = await readTurnSnapshot(userMessageId);
    ctx.appliedGuide = saved?.appliedGuide || null;
    await saveTurnSnapshot(userMessageId, ctx.sessionId, ctx.appliedGuide);
    return injectPrivateGuidance(body, ctx.config, ctx.appliedGuide);
  }

  const state = current.state || inactiveState();
  if (state.status === 'pending' && state.flow?.active && userMessageId) {
    const consumed = {
      ...state,
      status: 'consumed',
      consumedByUserMessageId: String(userMessageId),
    };
    const transitioned = await transitionState(ctx.sessionId, current.version, consumed);
    if (transitioned) {
      ctx.stateVersion = transitioned.version;
      ctx.appliedGuide = transitioned.state;
    } else {
      const latest = await readState(ctx.sessionId);
      ctx.stateVersion = latest.version;
      if (latest.state?.status === 'consumed' && String(latest.state.consumedByUserMessageId) === String(userMessageId)) {
        ctx.appliedGuide = latest.state;
      }
    }
  } else if (state.status === 'consumed' && userMessageId && String(state.consumedByUserMessageId) === String(userMessageId)) {
    ctx.appliedGuide = state;
  } else if (state.status === 'consumed' && userMessageId && String(state.consumedByUserMessageId) !== String(userMessageId)) {
    const recovered = await transitionState(ctx.sessionId, current.version, inactiveState());
    if (recovered) ctx.stateVersion = recovered.version;
    ctx.appliedGuide = null;
    console.log(`[intimacy:flow] stale consumed state cleared session=${ctx.sessionId}`);
  }

  if (userMessageId) await saveTurnSnapshot(userMessageId, ctx.sessionId, ctx.appliedGuide);
  return injectPrivateGuidance(body, ctx.config, ctx.appliedGuide);
}

async function commitReplyTransition(ctx, rawText) {
  if (!ctx?.sessionId || ctx.transitionDone || ctx.suppressStart) return;
  ctx.transitionDone = true;
  const config = ctx.config || await loadConfig();
  if (!config.enabled || !config.flow.enabled) return;

  const control = parseTrailingControl(rawText);
  const shouldTransition = Boolean(ctx.appliedGuide?.flow?.active || control?.action === 'start');
  if (!shouldTransition) return;

  const sourceKey = ctx.userMessageId || Date.now();
  const next = nextGuide(config, control, ctx.appliedGuide, sourceKey, Date.now());
  const nextStateValue = next || inactiveState();

  let expectedVersion = Number(ctx.stateVersion) || 0;
  if (ctx.rewriteMode) {
    const current = await readState(ctx.sessionId);
    expectedVersion = current.version;
  }
  let transitioned = await transitionState(ctx.sessionId, expectedVersion, nextStateValue);
  if (!transitioned && ctx.rewriteMode) {
    const latest = await readState(ctx.sessionId);
    transitioned = await transitionState(ctx.sessionId, latest.version, nextStateValue);
  }
  if (!transitioned) {
    console.warn(`[intimacy:flow] atomic transition skipped session=${ctx.sessionId}`);
    return;
  }

  const fromStage = ctx.appliedGuide?.flow?.stage || 'inactive';
  const toStage = transitioned.state?.flow?.active ? transitioned.state.flow.stage : 'inactive';
  console.log(`[intimacy:flow] session=${ctx.sessionId} ${fromStage}->${toStage} action=${control?.action || 'auto'}`);
}

async function processModelResponse(ctx, response) {
  if (!response?.ok || !ctx?.sessionId) return response;
  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }

  const rawText = responseText(payload);
  const sanitized = sanitizeReasoningFields(payload);
  if (rawText && !hasToolUse(payload)) {
    try {
      await commitReplyTransition(ctx, rawText);
    } catch (error) {
      console.warn('[intimacy:flow] transition failed:', error.message);
    }
  }
  return jsonResponseLike(response, sanitized);
}

installExpressContextBridge();

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function intimacyFlowFetch(input, init = {}) {
    const ctx = flowContext.getStore();
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    let isEligible = false;

    if (ctx?.sessionId && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        if (isMainChatRequest(url, body)) {
          const nextBody = await prepareGuidance(ctx, body);
          init = { ...init, body: JSON.stringify(nextBody) };
          isEligible = true;
        }
      } catch (error) {
        console.warn('[intimacy:flow] request guidance skipped:', error.message);
      }
    }

    const response = await previousFetch(input, init);
    if (!isEligible) return response;
    return processModelResponse(ctx, response);
  };
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function intimacyFlowHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, intimacy_flow: 'hidden-state-machine-v1' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[intimacy:flow] health marker unavailable:', error.message);
}

module.exports = {
  CONFIG_CACHE_MS,
  flowContext,
  loadConfig,
  readState,
  transitionState,
  readTurnSnapshot,
  saveTurnSnapshot,
  prepareGuidance,
  commitReplyTransition,
};
