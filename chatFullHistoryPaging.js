'use strict';

const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGES = 100;

function requestMethod(input, init = {}) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}

function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return String(input);
  return input?.url ? String(input.url) : '';
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

function isFullVisibleChatHistoryQuery(input, init = {}) {
  if (requestMethod(input, init) !== 'GET') return false;
  let url;
  try { url = new URL(requestUrl(input)); } catch { return false; }
  if (!/\/rest\/v1\/messages$/i.test(url.pathname)) return false;
  if (!String(url.searchParams.get('session_id') || '').startsWith('eq.')) return false;
  if (url.searchParams.get('visible') !== 'eq.true') return false;
  const order = String(url.searchParams.get('order') || '');
  if (!order.split(',').some(part => part.trim().startsWith('created_at.asc'))) return false;
  if (url.searchParams.has('limit') || url.searchParams.has('offset')) return false;
  return !mergedHeaders(input, init).has('Range');
}

async function parseRows(response) {
  const payload = await response?.clone?.().json().catch(() => null);
  return Array.isArray(payload) ? payload : null;
}

function responseWithRows(response, rows, pageCount) {
  const headers = new Headers(response?.headers || undefined);
  headers.delete('content-length');
  headers.delete('content-range');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('x-ourhome-chat-pages', String(pageCount));
  headers.set('x-ourhome-chat-rows', String(rows.length));
  return new Response(JSON.stringify(rows), {
    status: 200,
    statusText: response?.statusText || 'OK',
    headers,
  });
}

async function fetchAllChatHistoryRows(fetchImpl, input, init = {}, options = {}) {
  const pageSize = Math.max(1, Number(options.pageSize) || DEFAULT_PAGE_SIZE);
  const firstResponse = await fetchImpl(input, init);
  if (!firstResponse?.ok) return firstResponse;
  const firstRows = await parseRows(firstResponse);
  if (!firstRows || firstRows.length < pageSize) return firstResponse;

  const allRows = [...firstRows];
  let offset = firstRows.length;
  let pageCount = 1;

  while (pageCount < MAX_PAGES) {
    const headers = mergedHeaders(input, init);
    headers.set('Range-Unit', 'items');
    headers.set('Range', `${offset}-${offset + pageSize - 1}`);
    const pageResponse = await fetchImpl(input, { ...init, headers });
    if (!pageResponse?.ok) return firstResponse;
    const rows = await parseRows(pageResponse);
    if (!rows) return firstResponse;
    pageCount += 1;
    allRows.push(...rows);
    offset += rows.length;
    if (rows.length < pageSize) break;
  }

  const unique = [];
  const seen = new Set();
  allRows.forEach((row, index) => {
    const key = row?.id != null ? `id:${row.id}` : `fallback:${row?.created_at || ''}:${index}`;
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(row);
  });
  unique.sort((left, right) => {
    const byTime = Date.parse(left?.created_at || '') - Date.parse(right?.created_at || '');
    if (Number.isFinite(byTime) && byTime !== 0) return byTime;
    return Number(left?.id || 0) - Number(right?.id || 0);
  });
  return responseWithRows(firstResponse, unique, pageCount);
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGES,
  isFullVisibleChatHistoryQuery,
  fetchAllChatHistoryRows,
};
