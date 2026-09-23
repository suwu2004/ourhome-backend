'use strict';

const {
  SYNTHESIS_TIMEOUT_MS,
  safeJsonBody,
  hasUsableText,
  isLearningSynthesisRequest,
  isRetryableStatus,
  localFallbackResponse,
} = require('./luzeLearningResilience');

const providerFetch = globalThis.fetch;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithSynthesisTimeout(input, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNTHESIS_TIMEOUT_MS);
  try {
    // luzePrivateRoomPatch still owns a generic 55s timer. For synthesis only,
    // replace that signal with a longer one so a healthy long Opus response is
    // not killed a few seconds before completion.
    return await providerFetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

if (typeof providerFetch === 'function') {
  globalThis.fetch = async function luzeLearningResilienceFetch(input, init = {}) {
    if (!isLearningSynthesisRequest(init)) return providerFetch(input, init);

    const body = safeJsonBody(init) || {};
    try {
      let response = await fetchWithSynthesisTimeout(input, init);
      if (response.ok) {
        // A relay can return HTTP 200 with a valid-looking payload but zero usable
        // text (the same failure mode seen in foreground Chat). Do not issue a
        // second paid completion just to probe it; preserve the learning run
        // locally instead.
        try {
          const probe = response.clone();
          const raw = await probe.text();
          let payload = null;
          try { payload = raw ? JSON.parse(raw) : null; } catch { /* keep raw probe */ }
          if (!hasUsableText(payload)) {
            console.warn('[luze:learn] synthesis returned HTTP 200 with no usable text; saving local fallback note');
            return localFallbackResponse(body, 'HTTP 200 空正文');
          }
        return response;
      }

      if (!isRetryableStatus(response.status)) return response;

      console.warn(`[luze:learn] synthesis received transient HTTP ${response.status}; retrying once`);
      try { await response.body?.cancel?.(); } catch { /* best effort */ }
      await sleep(900);

      response = await fetchWithSynthesisTimeout(input, init);
      if (response.ok) return response;
      if (!isRetryableStatus(response.status)) return response;

      console.warn(`[luze:learn] synthesis still unavailable after retry (HTTP ${response.status}); saving local fallback note`);
      return localFallbackResponse(body, `HTTP ${response.status}`);
    } catch (error) {
      // Do not immediately issue another potentially billable request after an
      // ambiguous network/timeout failure. Preserve the run locally instead.
      const reason = error?.name === 'AbortError' ? '整理超时' : (error?.message || '网络异常');
      console.warn(`[luze:learn] synthesis transport failed; saving local fallback note: ${reason}`);
      return localFallbackResponse(body, reason);
    }
  };
}
