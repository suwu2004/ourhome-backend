'use strict';

// Provider-boundary singleflight: if two internal paths accidentally ask for the
// exact same model request at the same time, send it upstream once and fan the
// Response out to all waiters. This is intentionally narrower than HTTP
// idempotency: it only coalesces byte-for-byte equivalent model requests that are
// concurrent, so legitimate follow-up generations are never suppressed.
const providerFetch = globalThis.fetch;
const inFlight = new Map();
const MAX_ENTRIES = 128;

function requestUrl(input) {
  return typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
}

function requestBody(init) {
  return typeof init?.body === 'string' ? init.body : '';
}

function isModelRequest(url, init) {
  if (!init || String(init.method || 'POST').toUpperCase() !== 'POST') return false;
  return /\/(?:messages|chat\/completions|responses)\/?(?:\?|$)/i.test(url) && Boolean(requestBody(init));
}

function relevantHeaders(init = {}) {
  const headers = new Headers(init.headers || undefined);
  return [
    'authorization',
    'x-api-key',
    'anthropic-version',
    'anthropic-beta',
    'x-ourhome-call-purpose',
  ].map(name => `${name}:${headers.get(name) || ''}`).join('\n');
}

function fingerprint(input, init) {
  return `${requestUrl(input)}\n${relevantHeaders(init)}\n${requestBody(init)}`;
}

function trimEntries() {
  while (inFlight.size > MAX_ENTRIES) inFlight.delete(inFlight.keys().next().value);
}

async function fanOutResponse(promise, isFirst) {
  const response = await promise;
  // The first caller receives the original response. Waiting callers receive a
  // clone made before the first caller can consume its body.
  return isFirst ? response : response.clone();
}

if (typeof providerFetch === 'function') {
  globalThis.fetch = async function modelCallSingleflightFetch(input, init = {}) {
    const url = requestUrl(input);
    if (!isModelRequest(url, init)) return providerFetch(input, init);

    const key = fingerprint(input, init);
    const existing = inFlight.get(key);
    if (existing) {
      console.log('[model:singleflight] coalesced concurrent duplicate model call');
      return fanOutResponse(existing, false);
    }

    const request = providerFetch(input, init);
    const tracked = Promise.resolve(request).finally(() => {
      if (inFlight.get(key) === tracked) inFlight.delete(key);
    });
    inFlight.set(key, tracked);
    trimEntries();
    return fanOutResponse(tracked, true);
  };
}

module.exports = {
  fingerprint,
  isModelRequest,
};
