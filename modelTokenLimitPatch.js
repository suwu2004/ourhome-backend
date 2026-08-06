// Preload guard for provider/model output limits.
// The global OurHome reply ceiling may be 64K, while standard Kiro/Claude routes
// stay at 32K and explicitly marked PX/CX routes may use 64K.

const { clampRequestedOutputTokens, outputTokenCapForModel } = require('./modelTokenLimits');

const originalFetch = globalThis.fetch;

function isModelMessageRequest(url, body) {
  return /\/messages(?:\?|$)/i.test(String(url || ''))
    && body
    && typeof body === 'object'
    && body.model;
}

if (typeof originalFetch === 'function') {
  globalThis.fetch = async function modelTokenLimitedFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;

    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        if (isModelMessageRequest(url, body)) {
          const requested = Number(body.max_tokens) || 0;
          const cap = outputTokenCapForModel(body.model);
          const effective = clampRequestedOutputTokens(body.model, requested);
          body.max_tokens = effective;

          if (requested !== effective) {
            console.log(`[tokens:output] model=${body.model} requested=${requested || 'auto'} effective=${effective} cap=${cap}`);
          }

          init = {
            ...init,
            body: JSON.stringify(body),
          };
        }
      } catch (error) {
        console.warn('[tokens:output] request patch skipped:', error.message);
      }
    }

    return originalFetch(input, init);
  };
}
