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

module.exports = {
  WORKING_MEMORY_WINDOW_HOURS,
  normalizeJournalMark,
  workingMemoryCutoff,
};
