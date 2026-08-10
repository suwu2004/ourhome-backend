'use strict';

const DEFAULT_CHAT_HISTORY_PAGE_SIZE = 240;
const MIN_CHAT_HISTORY_PAGE_SIZE = 40;
const MAX_CHAT_HISTORY_PAGE_SIZE = 500;

function normalizePositiveInt(value, fallback = null) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return number;
}

function encodeChatHistoryCursor({ createdAt, skip } = {}) {
  const timestamp = String(createdAt || '').trim();
  const count = normalizePositiveInt(skip, 0) || 0;
  if (!timestamp || count <= 0) return null;
  return Buffer.from(JSON.stringify({ createdAt: timestamp, skip: count }), 'utf8').toString('base64url');
}

function decodeChatHistoryCursor(value) {
  const token = String(value || '').trim();
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    const createdAt = String(parsed?.createdAt || '').trim();
    const skip = normalizePositiveInt(parsed?.skip, 0) || 0;
    if (!createdAt || skip <= 0) return null;
    return { createdAt, skip };
  } catch {
    return null;
  }
}

function parseChatHistoryPaging(query = {}) {
  if (query.limit == null || query.limit === '') return null;
  const requested = normalizePositiveInt(query.limit, DEFAULT_CHAT_HISTORY_PAGE_SIZE);
  const limit = Math.max(MIN_CHAT_HISTORY_PAGE_SIZE, Math.min(MAX_CHAT_HISTORY_PAGE_SIZE, requested));
  return { limit, before: decodeChatHistoryCursor(query.before) };
}

function chatHistoryFetchLimit(paging) {
  if (!paging) return 0;
  return paging.limit + (paging.before?.skip || 0) + 1;
}

function finalizeChatHistoryPage(rows, paging) {
  const list = Array.isArray(rows) ? rows : [];
  const skip = paging?.before?.skip || 0;
  const cursorTimestamp = paging?.before?.createdAt || '';
  let skippedAtCursor = 0;
  const candidates = list.filter(row => {
    if (cursorTimestamp && row?.created_at === cursorTimestamp && skippedAtCursor < skip) {
      skippedAtCursor += 1;
      return false;
    }
    return true;
  });
  const hasMore = candidates.length > paging.limit;
  const selectedDescending = candidates.slice(0, paging.limit);
  const selected = [...selectedDescending].reverse();
  const oldest = selectedDescending.at(-1) || null;
  let nextBefore = null;
  if (oldest) {
    const oldestTimestamp = String(oldest.created_at || '');
    const selectedAtOldestTimestamp = selectedDescending.filter(row => row?.created_at === oldestTimestamp).length;
    const alreadySkipped = cursorTimestamp === oldestTimestamp ? skip : 0;
    nextBefore = encodeChatHistoryCursor({
      createdAt: oldestTimestamp,
      skip: alreadySkipped + selectedAtOldestTimestamp,
    });
  }
  return { messages: selected, hasMore, nextBefore };
}

module.exports = {
  DEFAULT_CHAT_HISTORY_PAGE_SIZE,
  MIN_CHAT_HISTORY_PAGE_SIZE,
  MAX_CHAT_HISTORY_PAGE_SIZE,
  encodeChatHistoryCursor,
  decodeChatHistoryCursor,
  parseChatHistoryPaging,
  chatHistoryFetchLimit,
  finalizeChatHistoryPage,
};
