'use strict';

const DEFAULT_CHAT_HISTORY_PAGE_SIZE = 240;
const MIN_CHAT_HISTORY_PAGE_SIZE = 40;
const MAX_CHAT_HISTORY_PAGE_SIZE = 500;

function normalizePositiveInt(value, fallback = null) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return number;
}

function parseChatHistoryPaging(query = {}) {
  if (query.limit == null || query.limit === '') return null;
  const requested = normalizePositiveInt(query.limit, DEFAULT_CHAT_HISTORY_PAGE_SIZE);
  const limit = Math.max(MIN_CHAT_HISTORY_PAGE_SIZE, Math.min(MAX_CHAT_HISTORY_PAGE_SIZE, requested));
  const before = String(query.before || '').trim();
  return { limit, before: before || '' };
}

function finalizeChatHistoryPage(rows, limit) {
  const list = Array.isArray(rows) ? rows : [];
  const hasMore = list.length > limit;
  const selected = list.slice(0, limit).reverse();
  return {
    messages: selected,
    hasMore,
    nextBefore: selected[0]?.created_at || null,
  };
}

module.exports = {
  DEFAULT_CHAT_HISTORY_PAGE_SIZE,
  MIN_CHAT_HISTORY_PAGE_SIZE,
  MAX_CHAT_HISTORY_PAGE_SIZE,
  parseChatHistoryPaging,
  finalizeChatHistoryPage,
};
