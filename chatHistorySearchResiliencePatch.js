'use strict';

// Chat-history search is read-only. If PostgREST cannot resolve the optional
// `sessions(name)` embed, retry the same database lookup once without the embed
// instead of making the model retry the whole tool call with another keyword.
const previousFetch = globalThis.fetch;

function requestMethod(input, init = {}) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}

function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return String(input);
  return String(input?.url || '');
}

function fallbackMessagesSearchUrl(input, init = {}) {
  if (requestMethod(input, init) !== 'GET') return null;
  const raw = requestUrl(input);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!/\/rest\/v1\/messages$/i.test(url.pathname)) return null;
    const select = url.searchParams.get('select') || '';
    if (!/sessions\s*\(\s*name\s*\)/i.test(select)) return null;
    const simplified = select
      .replace(/\s*,?\s*sessions\s*\(\s*name\s*\)\s*,?/i, ',')
      .replace(/^,|,$/g, '');
    if (!simplified || simplified === select) return null;
    url.searchParams.set('select', simplified);
    return url.toString();
  } catch {
    return null;
  }
}

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function chatHistorySearchResilienceFetch(input, init = {}) {
    const fallbackUrl = fallbackMessagesSearchUrl(input, init);
    if (!fallbackUrl) return previousFetch(input, init);

    const first = await previousFetch(input, init);
    if (first.ok || first.status < 400 || first.status >= 500) return first;

    console.warn(`[chat:history-search] embedded session lookup returned ${first.status}; retrying without optional session name`);
    return previousFetch(fallbackUrl, init);
  };
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function chatHistorySearchHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, chat_history_search_resilience: 'session-embed-fallback-v1' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[chat:history-search] health marker unavailable:', error.message);
}

module.exports = { fallbackMessagesSearchUrl };
