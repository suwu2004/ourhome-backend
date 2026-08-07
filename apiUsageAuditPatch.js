'use strict';

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const express = require('express');

// Loaded after thinkingTransportPatch, so this function is the finalized outbound
// transport. It may answer tiny local compatibility probes without touching the
// paid provider; those local probes are explicitly excluded from the audit below.
const upstreamFetch = globalThis.fetch;
const requestContext = new AsyncLocalStorage();
const PROFILE_CACHE_MS = 60_000;
let profileCache = { expiresAt: 0, rows: [] };

function envReady() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_KEY && typeof upstreamFetch === 'function');
}

function safeUrl(value) {
  try { return new URL(String(value || '')); } catch { return null; }
}

function normalizeBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isModelRequest(url, body) {
  if (!body || typeof body !== 'object' || !body.model) return false;
  const parsed = safeUrl(url);
  if (!parsed) return false;
  return /\/(?:messages|chat\/completions|responses)\/?$/i.test(parsed.pathname);
}

function messageText(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map(message => {
      if (typeof message?.content === 'string') return message.content;
      if (!Array.isArray(message?.content)) return '';
      return message.content
        .map(block => typeof block === 'string' ? block : block?.text || '')
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

function isLocalThinkingDecision(body) {
  const text = messageText(body?.messages);
  return Number(body?.max_tokens || 0) <= 20
    && text.includes('只回答一个词')
    && text.includes('想 或者 不想');
}

function protocolFor(url) {
  const path = safeUrl(url)?.pathname || '';
  if (/\/messages\/?$/i.test(path)) return 'anthropic';
  if (/\/responses\/?$/i.test(path)) return 'openai-responses';
  if (/\/chat\/completions\/?$/i.test(path)) return 'openai-chat';
  return 'unknown';
}

function usageFrom(payload) {
  const usage = payload?.usage || {};
  const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? null;
  const output = usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? null;
  return {
    inputTokens: Number.isFinite(Number(input)) ? Number(input) : null,
    outputTokens: Number.isFinite(Number(output)) ? Number(output) : null,
  };
}

function compactError(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max) || null;
}

async function supabaseRest(path, options = {}) {
  if (!envReady()) return null;
  const base = String(process.env.SUPABASE_URL).replace(/\/+$/, '');
  return upstreamFetch(`${base}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
      ...(options.headers || {}),
    },
  });
}

async function loadProfiles() {
  if (profileCache.expiresAt > Date.now()) return profileCache.rows;
  try {
    const response = await supabaseRest('api_profiles?select=id,name,base_url');
    if (!response?.ok) throw new Error(`profile status ${response?.status || 0}`);
    const rows = await response.json();
    profileCache = { expiresAt: Date.now() + PROFILE_CACHE_MS, rows: Array.isArray(rows) ? rows : [] };
  } catch (error) {
    console.warn('[api-audit] profile lookup skipped:', error.message);
    profileCache = { expiresAt: Date.now() + 10_000, rows: [] };
  }
  return profileCache.rows;
}

async function resolveProfile(url) {
  const target = String(url || '');
  const profiles = await loadProfiles();
  const matched = profiles
    .filter(profile => normalizeBase(profile.base_url) && target.startsWith(normalizeBase(profile.base_url)))
    .sort((a, b) => normalizeBase(b.base_url).length - normalizeBase(a.base_url).length)[0];
  return matched ? { id: String(matched.id), name: String(matched.name || '') } : { id: null, name: null };
}

async function persistLog(row) {
  if (!envReady()) return;
  try {
    const response = await supabaseRest('api_call_logs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!response?.ok) console.warn('[api-audit] insert failed:', response?.status, (await response.text().catch(() => '')).slice(0, 180));
  } catch (error) {
    console.warn('[api-audit] insert failed:', error.message);
  }
}

function auditContext() {
  const context = requestContext.getStore();
  if (context) {
    context.callIndex += 1;
    return {
      requestId: context.requestId,
      callIndex: context.callIndex,
      source: context.req?.path || context.req?.originalUrl || 'request',
      sessionId: Number.isFinite(Number(context.req?.body?.session_id)) ? Number(context.req.body.session_id) : null,
    };
  }
  return {
    requestId: `background-${crypto.randomUUID()}`,
    callIndex: 1,
    source: 'background',
    sessionId: null,
  };
}

if (typeof upstreamFetch === 'function') {
  globalThis.fetch = async function auditedFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    let body = null;
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = null; }
    }
    if (!isModelRequest(url, body)) return upstreamFetch(input, init);

    // thinkingTransportPatch resolves this tiny compatibility probe locally. It is
    // deliberately not a paid provider call and must never inflate the usage log.
    if (isLocalThinkingDecision(body)) return upstreamFetch(input, init);

    const context = auditContext();
    const startedAt = new Date();
    const startedMs = startedAt.getTime();
    const parsedUrl = safeUrl(url);
    const profilePromise = resolveProfile(url);
    let response;
    let payload = null;
    let rawText = '';
    let thrown = null;

    try {
      response = await upstreamFetch(input, init);
      try {
        rawText = await response.clone().text();
        payload = rawText ? JSON.parse(rawText) : null;
      } catch {
        payload = null;
      }
      return response;
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      const finishedAt = new Date();
      const profile = await profilePromise.catch(() => ({ id: null, name: null }));
      const usage = usageFrom(payload);
      const status = response?.ok ? 'success' : 'error';
      const errorDetail = thrown
        ? compactError(thrown.message || thrown)
        : !response?.ok
          ? compactError(payload?.error?.message || payload?.error || rawText)
          : null;
      const row = {
        request_id: context.requestId,
        call_index: context.callIndex,
        source: context.source,
        session_id: context.sessionId,
        api_profile_id: profile.id,
        api_profile_name: profile.name,
        api_origin: parsedUrl?.origin || null,
        endpoint: parsedUrl?.pathname || null,
        model: String(body?.model || '').slice(0, 240),
        protocol: protocolFor(url),
        status,
        http_status: response?.status || null,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        request_chars: typeof init?.body === 'string' ? init.body.length : null,
        response_chars: rawText ? rawText.length : null,
        duration_ms: finishedAt.getTime() - startedMs,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        provider_response_id: payload?.id ? String(payload.id).slice(0, 240) : null,
        error_detail: errorDetail,
      };
      persistLog(row).catch(() => {});
      console.log(`[api-audit] ${row.request_id} #${row.call_index} ${row.source} ${profile.name || row.api_origin || ''} model=${row.model} status=${row.http_status || 'ERR'} in=${row.input_tokens ?? '?'} out=${row.output_tokens ?? '?'} ${row.duration_ms}ms`);
    }
  };
}

const originalHandle = express.application.handle;
express.application.handle = function auditedExpressHandle(req, res, done) {
  const incoming = String(req.headers?.['x-ourhome-request-id'] || '').trim().slice(0, 120);
  const requestId = incoming || crypto.randomUUID();
  res.setHeader('X-OurHome-Request-Id', requestId);
  return requestContext.run({ requestId, callIndex: 0, req }, () => originalHandle.call(this, req, res, done));
};

async function readLogs({ hours = 24, limit = 100 } = {}) {
  const safeHours = Math.max(1, Math.min(24 * 30, Number(hours) || 24));
  const safeLimit = Math.max(1, Math.min(300, Number(limit) || 100));
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
  const query = new URLSearchParams({
    select: '*',
    created_at: `gte.${since}`,
    order: 'created_at.desc',
    limit: String(safeLimit),
  });
  const response = await supabaseRest(`api_call_logs?${query.toString()}`);
  if (!response?.ok) throw new Error(`读取 API 日志失败 (${response?.status || 0})`);
  const logs = await response.json();
  const rows = Array.isArray(logs) ? logs : [];
  const summary = rows.reduce((acc, row) => {
    acc.calls += 1;
    if (row.status === 'error') acc.failed += 1;
    acc.input_tokens += Number(row.input_tokens) || 0;
    acc.output_tokens += Number(row.output_tokens) || 0;
    return acc;
  }, { calls: 0, failed: 0, input_tokens: 0, output_tokens: 0 });
  return { hours: safeHours, logs: rows, summary };
}

const originalListen = express.application.listen;
express.application.listen = function auditedListen(...args) {
  if (!this.__ourhomeApiAuditRoutes) {
    this.__ourhomeApiAuditRoutes = true;
    this.get('/api-usage/logs', async (req, res) => {
      try {
        res.json(await readLogs({ hours: req.query.hours, limit: req.query.limit }));
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }
  return originalListen.apply(this, args);
};

try {
  const originalJson = express.response.json;
  express.response.json = function apiAuditMarker(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, api_usage_audit: 'provider-call-audit-v2' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[api-audit] marker unavailable:', error.message);
}
