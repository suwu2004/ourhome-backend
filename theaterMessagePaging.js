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

function isTheaterMessageQuery(input, init = {}) {
  if (requestMethod(input, init) !== 'GET') return false;
  const raw = requestUrl(input);
  if (!raw) return false;

  let url;
  try { url = new URL(raw); } catch { return false; }
  if (!/\/rest\/v1\/letters$/i.test(url.pathname)) return false;
  if (url.searchParams.get('category') !== 'eq.小剧场') return false;

  const parent = String(url.searchParams.get('parent_id') || '');
  if (!(parent.startsWith('eq.') || parent.startsWith('in.('))) return false;

  const order = String(url.searchParams.get('order') || '');
  if (!order.split(',').some(part => part.trim().startsWith('created_at.asc'))) return false;

  // Explicitly paged callers own their own window. This patch only protects the
  // legacy full-history queries used by Theater book loading and generation.
  if (url.searchParams.has('limit') || url.searchParams.has('offset')) return false;
  const headers = mergedHeaders(input, init);
  if (headers.has('Range')) return false;
  return true;
}

function responseWithRows(response, rows, pageCount, strategy = 'range') {
  const headers = new Headers(response?.headers || undefined);
  headers.delete('content-length');
  headers.delete('content-range');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('x-ourhome-theater-pages', String(pageCount));
  headers.set('x-ourhome-theater-rows', String(rows.length));
  headers.set('x-ourhome-theater-strategy', strategy);
  return new Response(JSON.stringify(rows), {
    status: response?.status && response.status >= 200 && response.status < 300 ? 200 : (response?.status || 200),
    statusText: response?.statusText || 'OK',
    headers,
  });
}

async function parseRows(response) {
  const payload = await response?.clone?.().json().catch(() => null);
  return Array.isArray(payload) ? payload : null;
}

function parseParentIds(input) {
  const raw = requestUrl(input);
  let url;
  try { url = new URL(raw); } catch { return []; }
  const parent = String(url.searchParams.get('parent_id') || '');
  if (!parent.startsWith('in.(') || !parent.endsWith(')')) return [];
  return [...new Set(parent.slice(4, -1)
    .split(',')
    .map(item => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean))];
}

function urlForParent(input, parentId) {
  const url = new URL(requestUrl(input));
  url.searchParams.set('parent_id', `eq.${parentId}`);
  return url.toString();
}

function rowIdentity(row, index) {
  if (row?.id != null) return `id:${row.id}`;
  return `fallback:${row?.parent_id || ''}:${row?.created_at || ''}:${index}`;
}

function sortRows(rows) {
  return [...rows].sort((left, right) => {
    const byTime = Date.parse(left?.created_at || '') - Date.parse(right?.created_at || '');
    if (Number.isFinite(byTime) && byTime !== 0) return byTime;
    return String(left?.id || '').localeCompare(String(right?.id || ''));
  });
}

async function fetchPagedRows(fetchImpl, input, init = {}, pageSize = DEFAULT_PAGE_SIZE) {
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
    if (!pageResponse?.ok) {
      console.warn(`[theater:paging] page ${pageCount + 1} failed with ${pageResponse?.status || 'unknown'}; keeping first page`);
      return firstResponse;
    }

    const pageRows = await parseRows(pageResponse);
    if (!pageRows) return firstResponse;
    pageCount += 1;
    allRows.push(...pageRows);
    offset += pageRows.length;
    if (pageRows.length < pageSize) break;
  }

  if (pageCount >= MAX_PAGES) {
    console.warn(`[theater:paging] stopped after ${MAX_PAGES} pages (${allRows.length} rows)`);
  }
  return responseWithRows(firstResponse, allRows, pageCount, 'range');
}

async function fetchAllTheaterMessageRows(fetchImpl, input, init = {}, options = {}) {
  const pageSize = Math.max(1, Number(options.pageSize) || DEFAULT_PAGE_SIZE);
  const parentIds = parseParentIds(input);

  // The shelf used to read every Theater book in one giant ordered query. Once
  // the combined collection crossed Supabase's row cap, one book could lose its
  // newest rows even though that individual book was still small. Read each book
  // independently, then merge them back into the exact shape the legacy route
  // expects. Individual books still get range paging when they themselves grow.
  if (parentIds.length > 1) {
    const rows = [];
    let templateResponse = null;
    let requestPages = 0;

    for (const parentId of parentIds) {
      const response = await fetchPagedRows(fetchImpl, urlForParent(input, parentId), init, pageSize);
      if (!response?.ok) return fetchPagedRows(fetchImpl, input, init, pageSize);
      const parentRows = await parseRows(response);
      if (!parentRows) return fetchPagedRows(fetchImpl, input, init, pageSize);
      templateResponse ||= response;
      requestPages += Math.max(1, Number(response.headers?.get?.('x-ourhome-theater-pages')) || 1);
      rows.push(...parentRows);
    }

    const seen = new Set();
    const uniqueRows = [];
    rows.forEach((row, index) => {
      const key = rowIdentity(row, index);
      if (seen.has(key)) return;
      seen.add(key);
      uniqueRows.push(row);
    });
    return responseWithRows(templateResponse, sortRows(uniqueRows), requestPages, 'per-book');
  }

  return fetchPagedRows(fetchImpl, input, init, pageSize);
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGES,
  requestUrl,
  mergedHeaders,
  isTheaterMessageQuery,
  parseParentIds,
  fetchAllTheaterMessageRows,
};
