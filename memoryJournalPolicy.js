'use strict';

const WORKING_MEMORY_WINDOW_HOURS = 72;

function compact(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clampImportance(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(1, Math.min(5, parsed));
}

function normalizeJournalMark(value = {}) {
  const summary = compact(value.summary, 240);
  const shouldContinue = Boolean(value.should_continue);
  const shouldRemember = Boolean(value.should_remember);
  // Storage is an independent model decision. `should_continue` describes whether
  // an already-worthy note is unfinished; `should_remember` is only a durability
  // hint. Neither flag is allowed to silently manufacture a temporary memory.
  const shouldStore = value.should_store === true;
  return {
    summary,
    importance: clampImportance(value.importance),
    shouldContinue,
    shouldRemember,
    shouldStore: Boolean(summary) && shouldStore,
  };
}

function workingMemoryCutoff(now = new Date()) {
  return new Date(now.getTime() - WORKING_MEMORY_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
}

// The chat prompt historically queried memory_marks with `should_continue=true`.
// That is correct for unfinished threads, but it accidentally hid short-lived facts
// that the journal model explicitly chose to store (for example a meal from yesterday).
// Keep the database schema stable and broaden only the dedicated 72h working-memory
// query to include all active/continued marks in that window. The memory-log page,
// which is a user-facing list of unfinished threads, keeps its original semantics.
const previousFetch = globalThis.fetch;

function requestMethod(input, init = {}) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}

function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return String(input);
  return String(input?.url || '');
}

function isWorkingMemoryMarksRead(input, init = {}) {
  if (requestMethod(input, init) !== 'GET') return false;
  const raw = requestUrl(input);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (!/\/rest\/v1\/memory_marks$/i.test(url.pathname)) return false;
    const query = url.search;
    return /created_at=gte\./i.test(query)
      && /expires_at\.(?:is\.null|gt\.)/i.test(query)
      && /should_continue=eq\.true/i.test(query);
  } catch {
    return false;
  }
}

function broadenWorkingMemoryRead(input, init = {}) {
  const raw = requestUrl(input);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.searchParams.delete('should_continue');
    return url.toString();
  } catch {
    return null;
  }
}

function markStoreMetadata(input, init = {}) {
  if (requestMethod(input, init) !== 'POST') return null;
  const raw = requestUrl(input);
  if (!/\/rest\/v1\/memory_marks$/i.test(raw)) return null;
  const body = init?.body;
  if (typeof body !== 'string') return null;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    parsed.metadata = {
      ...(parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : {}),
      should_store: true,
    };
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function memoryJournalPolicyFetch(input, init = {}) {
    if (isWorkingMemoryMarksRead(input, init)) {
      const broadenedUrl = broadenWorkingMemoryRead(input, init);
      if (broadenedUrl) return previousFetch(broadenedUrl, init);
    }

    const metadataBody = markStoreMetadata(input, init);
    if (metadataBody) return previousFetch(input, { ...init, body: metadataBody });
    return previousFetch(input, init);
  };
}

module.exports = {
  WORKING_MEMORY_WINDOW_HOURS,
  normalizeJournalMark,
  workingMemoryCutoff,
};
