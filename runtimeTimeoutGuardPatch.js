'use strict';

const { timeoutForRequest } = require('./runtimeTimeoutGuard');

const providerFetch = globalThis.fetch;

if (typeof providerFetch === 'function') {
  globalThis.fetch = async function runtimeTimeoutGuardFetch(input, init = {}) {
    const timeoutMs = timeoutForRequest(init);
    if (!timeoutMs) return providerFetch(input, init);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // These requests already have shorter caller-owned signals (or, for the
      // heartbeat, can otherwise inherit a very long transport hang). Replace
      // only those positively identified signals with one bounded single-call
      // window. There is deliberately no retry here, so this never creates a
      // second provider request or doubles token cost.
      return await providerFetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}
