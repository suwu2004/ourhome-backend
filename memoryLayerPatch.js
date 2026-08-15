// Preload support for OurHome layered memory.
// Normal memory reads only see active core / episodic / temporary records.
// A lightweight database consolidation runs after startup and then every six hours.

const { filteredMemoryInput, isMemoryTableRead, requestUrl } = require('./memoryLayers');
const {
  EXACT_THREAD_WINDOW_MS,
  RECENT_THREAD_LIMIT,
  findWorkingMemoryThreadMatch,
  mergeWorkingMemoryThread,
} = require('./workingMemoryThreadDedupe');

const originalFetch = globalThis.fetch;
const CONSOLIDATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const workingMemoryWriteChains = new Map();

function requestMethod(input, init = {}) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}

function broadenWorkingMemoryList(input, init = {}) {
  if (requestMethod(input, init) !== 'GET') return input;
  const raw = requestUrl(input);
  if (!raw) return input;
  try {
    const parsed = new URL(raw);
    if (!/\/rest\/v1\/memory_marks$/i.test(parsed.pathname)) return input;
    // This signature is the user-facing /memory-log list. Keep the much smaller
    // should_continue-only query used for Chat prompt injection untouched.
    if (parsed.searchParams.get('select') !== '*') return input;
    if (parsed.searchParams.get('limit') !== '40') return input;
    if (!parsed.searchParams.has('mark_date')) return input;
    if (parsed.searchParams.get('should_continue') !== 'eq.true') return input;
    parsed.searchParams.delete('should_continue');
    const next = parsed.toString();
    if (typeof input === 'string') return next;
    if (input instanceof URL) return new URL(next);
    if (typeof Request !== 'undefined' && input instanceof Request) return new Request(next, input);
  } catch {
    return input;
  }
  return input;
}

function parseRequestJson(init = {}) {
  if (typeof init?.body !== 'string' || !init.body.trim()) return null;
  try {
    const parsed = JSON.parse(init.body);
    if (Array.isArray(parsed)) return parsed.length === 1 ? parsed[0] : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isJournalWorkingMemoryInsert(input, init = {}, candidate = parseRequestJson(init)) {
  if (requestMethod(input, init) !== 'POST' || !candidate) return false;
  const raw = requestUrl(input);
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    if (!/\/rest\/v1\/memory_marks$/i.test(parsed.pathname)) return false;
  } catch {
    return false;
  }
  // Manual memory edits do not carry the paired assistant message marker. Limit
  // rolling dedupe to the automatic memory-journal writer only.
  return candidate.role === 'user'
    && Boolean(String(candidate.summary || '').trim())
    && Boolean(candidate.metadata?.assistant_message_id);
}

function mergedHeaders(input, init = {}) {
  const headers = new Headers();
  if (typeof Request !== 'undefined' && input instanceof Request) {
    new Headers(input.headers).forEach((value, key) => headers.set(key, value));
  }
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

function serializeWorkingMemoryWrite(key, task) {
  const queueKey = String(key || 'journal-global');
  const previous = workingMemoryWriteChains.get(queueKey) || Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  workingMemoryWriteChains.set(queueKey, current);
  current.finally(() => {
    if (workingMemoryWriteChains.get(queueKey) === current) workingMemoryWriteChains.delete(queueKey);
  }).catch(() => undefined);
  return current;
}

async function fetchRecentWorkingMemoryMarks(input, init, candidate, now = new Date()) {
  const raw = requestUrl(input);
  const parsed = new URL(raw);
  parsed.search = '';
  parsed.searchParams.set('select', 'id,message_id,session_id,mark_date,role,topic,emotion,summary,tags,importance,should_continue,should_remember,status,metadata,created_at,updated_at,expires_at,reinforcement_count');
  parsed.searchParams.set('status', 'in.(active,continued)');
  // Exact summary/topic continuity is allowed throughout the same 72-hour
  // working-memory window even if the user opened a different Chat session.
  // Fuzzy merging remains session-local inside the matcher.
  parsed.searchParams.set('updated_at', `gte.${new Date(now.getTime() - EXACT_THREAD_WINDOW_MS).toISOString()}`);
  parsed.searchParams.set('or', `(expires_at.is.null,expires_at.gt.${now.toISOString()})`);
  parsed.searchParams.set('order', 'updated_at.desc');
  parsed.searchParams.set('limit', String(RECENT_THREAD_LIMIT));

  const headers = mergedHeaders(input, init);
  headers.set('Accept', 'application/json');
  headers.delete('Prefer');
  const response = await originalFetch(parsed.toString(), { method: 'GET', headers });
  if (!response.ok) return null;
  const rows = await response.json().catch(() => null);
  return Array.isArray(rows) ? rows : null;
}

async function updateWorkingMemoryThread(input, init, keeper, candidate, reason, now = new Date()) {
  const raw = requestUrl(input);
  const parsed = new URL(raw);
  parsed.search = '';
  parsed.searchParams.set('id', `eq.${keeper.id}`);

  const headers = mergedHeaders(input, init);
  headers.set('Content-Type', 'application/json');
  headers.set('Prefer', 'return=minimal');
  const merged = mergeWorkingMemoryThread(keeper, candidate, { reason, now });
  const response = await originalFetch(parsed.toString(), {
    method: 'PATCH',
    headers,
    body: JSON.stringify(merged),
  });
  return response;
}

async function rollupJournalWorkingMemory(input, init, candidate) {
  const now = new Date();
  const recent = await fetchRecentWorkingMemoryMarks(input, init, candidate, now).catch(error => {
    console.warn('[memory:working] recent-thread lookup skipped:', error.message);
    return null;
  });
  if (!recent) return originalFetch(input, init);

  const match = findWorkingMemoryThreadMatch(candidate, recent, now.getTime());
  if (!match) return originalFetch(input, init);

  const updated = await updateWorkingMemoryThread(input, init, match.row, candidate, match.reason, now)
    .catch(error => {
      console.warn('[memory:working] rolling update failed:', error.message);
      return null;
    });
  if (!updated?.ok) {
    if (updated) console.warn(`[memory:working] rolling update returned ${updated.status}; keeping normal insert`);
    return originalFetch(input, init);
  }

  console.info(`[memory:working] rolled ${match.reason} into ${match.row.id}`);
  return updated;
}

async function runMemoryConsolidation() {
  const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_KEY || '';
  if (!baseUrl || !key || typeof originalFetch !== 'function') return null;

  const response = await originalFetch(`${baseUrl}/rest/v1/rpc/ourhome_consolidate_memory_layers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: '{}',
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`memory consolidation failed (${response.status}) ${detail}`.trim());
  }

  const result = await response.json().catch(() => ({}));
  console.log('[memory:layers] consolidation complete', JSON.stringify(result));
  return result;
}

if (typeof originalFetch === 'function') {
  globalThis.fetch = async function layeredMemoryFetch(input, init = {}) {
    let nextInput = input;
    try {
      nextInput = filteredMemoryInput(input, init);
      nextInput = broadenWorkingMemoryList(nextInput, init);
      if (nextInput !== input && isMemoryTableRead(input, init)) {
        console.log(`[memory:layers] active read ${requestUrl(nextInput)}`);
      }
    } catch (error) {
      console.warn('[memory:layers] read filter skipped:', error.message);
    }

    const candidate = parseRequestJson(init);
    if (isJournalWorkingMemoryInsert(nextInput, init, candidate)) {
      // Cross-session dedupe needs one small global write queue; otherwise two Chat
      // sessions could race and both insert the same temporary-memory thread.
      return serializeWorkingMemoryWrite('journal-global', () => rollupJournalWorkingMemory(nextInput, init, candidate));
    }
    return originalFetch(nextInput, init);
  };

  const firstRun = setTimeout(() => {
    runMemoryConsolidation().catch(error => console.warn('[memory:layers]', error.message));
  }, 8_000);
  firstRun.unref?.();

  const interval = setInterval(() => {
    runMemoryConsolidation().catch(error => console.warn('[memory:layers]', error.message));
  }, CONSOLIDATION_INTERVAL_MS);
  interval.unref?.();
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function patchedMemoryHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = {
        ...body,
        memory_layers: 'model-owned-working-memory-v3',
        working_memory_dedup: 'rolling-thread-v3-cross-session',
      };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[memory:layers] health marker unavailable:', error.message);
}

module.exports = {
  CONSOLIDATION_INTERVAL_MS,
  broadenWorkingMemoryList,
  parseRequestJson,
  isJournalWorkingMemoryInsert,
  serializeWorkingMemoryWrite,
  fetchRecentWorkingMemoryMarks,
  updateWorkingMemoryThread,
  rollupJournalWorkingMemory,
  runMemoryConsolidation,
};
