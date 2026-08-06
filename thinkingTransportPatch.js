// Preload patch for Claude-compatible relay endpoints.
// Some relay model names carry routing prefixes such as [C1], while still
// supporting Anthropic's native extended-thinking request format. The main
// server historically withheld the native parameter from every non-official
// endpoint, which left reasoning_content empty on those relays.

const originalFetch = globalThis.fetch;

function systemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map(block => typeof block === 'string' ? block : block?.text || block?.content || '')
    .filter(Boolean)
    .join('\n');
}

function shouldEnableNativeThinking(url, body) {
  if (!/\/messages(?:\?|$)/i.test(String(url || ''))) return false;
  const model = String(body?.model || '').toLowerCase();
  if (!model.includes('claude') || !model.includes('thinking')) return false;

  // Only touch the main OurHome chat path. Background JSON analysis, image
  // readers and mail checks must keep their original deterministic settings.
  const system = systemText(body?.system);
  return system.includes('【每轮可见思考】') || system.includes('【可见的内心独白】');
}

if (typeof originalFetch === 'function') {
  globalThis.fetch = async function patchedFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        if (shouldEnableNativeThinking(url, body)) {
          const maxTokens = Number(body.max_tokens) || 0;
          const safeBudget = Math.max(1024, Math.min(3000, maxTokens > 1200 ? maxTokens - 800 : 1024));
          body.thinking = { type: 'enabled', budget_tokens: safeBudget };
          body.temperature = 1;

          const headers = new Headers(init.headers || undefined);
          headers.set('anthropic-beta', 'interleaved-thinking-2025-05-14');
          init = {
            ...init,
            headers,
            body: JSON.stringify(body),
          };
          console.log(`[thinking:relay] enabled native Claude thinking model=${body.model} budget=${safeBudget}`);
        }
      } catch (error) {
        console.warn('[thinking:relay] request patch skipped:', error.message);
      }
    }
    return originalFetch(input, init);
  };
}
