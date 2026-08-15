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

function responseWithRows(response, rows, pageCount) {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-range');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('x-ourhome-theater-pages', String(pageCount));
  return new Response(JSON.stringify(rows), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function parseRows(response) {
  const payload = await response.clone().json().catch(() => null);
  return Array.isArray(payload) ? payload : null;
}

async function fetchAllTheaterMessageRows(fetchImpl, input, init = {}, options = {}) {
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
  return responseWithRows(firstResponse, allRows, pageCount);
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGES,
  requestUrl,
  mergedHeaders,
  isTheaterMessageQuery,
  fetchAllTheaterMessageRows,
};
