'use strict';

// Keep the Neon failover responsive while Supabase REST is quota-blocked.
// This patch runs *before* neonFailoverFetchPatch.js.  A synthetic 402 therefore
// flows into the existing, well-tested Neon fallback without changing its data
// semantics.  Supabase remains primary: after a short cooldown one shared,
// read-only probe decides whether normal traffic should return to Supabase.

const DEFAULT_COOLDOWN_MS = 30_000;
const MIN_COOLDOWN_MS = 5_000;
const MAX_COOLDOWN_MS = 5 * 60_000;

function normalizedBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function requestUrl(input) {
  return typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
}

function cooldownMsFrom(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_COOLDOWN_MS;
  return Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, Math.round(parsed)));
}

function isSupabaseRestUrl(value, supabaseUrl) {
  const base = normalizedBase(supabaseUrl);
  return Boolean(base && String(value || '').startsWith(`${base}/rest/v1/`));
}

function isPrimaryProbeUrl(value, supabaseUrl) {
  const base = normalizedBase(supabaseUrl);
  if (!base) return false;
  try {
    const url = new URL(String(value || ''));
    const baseUrl = new URL(base);
    return url.origin === baseUrl.origin
      && url.pathname === '/rest/v1/settings'
      && url.searchParams.get('select') === 'id'
      && url.searchParams.get('limit') === '1';
  } catch {
    return false;
  }
}

function syntheticQuotaResponse() {
  return new Response(JSON.stringify({
    message: 'Supabase REST quota circuit is temporarily open',
    code: 'OURHOME_SUPABASE_QUOTA_CIRCUIT',
    details: null,
    hint: null,
  }), {
    status: 402,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-OurHome-Supabase-Circuit': 'open',
    },
  });
}

function probeHeaders(input, init = {}) {
  const source = new Headers(init.headers || input?.headers || undefined);
  const headers = new Headers();
  for (const name of ['apikey', 'authorization']) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('Accept', 'application/json');
  return headers;
}

function createSupabaseQuotaCircuitFetch({
  fetchImpl,
  supabaseUrl,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const base = normalizedBase(supabaseUrl);
  const cooldown = cooldownMsFrom(cooldownMs);
  let quotaBlocked = false;
  let blockedUntil = 0;
  let recoveryProbePromise = null;

  const markBlocked = () => {
    quotaBlocked = true;
    blockedUntil = now() + cooldown;
  };

  const markReady = () => {
    quotaBlocked = false;
    blockedUntil = 0;
  };

  const updateFromProbeResponse = response => {
    if (response?.status === 402) markBlocked();
    else if (response?.ok) markReady();
    return response;
  };

  const runRecoveryProbe = (input, init) => {
    if (recoveryProbePromise) return recoveryProbePromise;
    const url = `${base}/rest/v1/settings?select=id&limit=1`;
    recoveryProbePromise = (async () => {
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: probeHeaders(input, init),
          cache: 'no-store',
        });
        updateFromProbeResponse(response);
        if (!response.ok) {
          if (response.status !== 402) blockedUntil = now() + Math.min(cooldown, 10_000);
          return false;
        }
        return true;
      } catch {
        blockedUntil = now() + Math.min(cooldown, 10_000);
        return false;
      } finally {
        recoveryProbePromise = null;
      }
    })();
    return recoveryProbePromise;
  };

  const circuitFetch = async (input, init = {}) => {
    const url = requestUrl(input);
    if (!isSupabaseRestUrl(url, base)) return fetchImpl(input, init);

    // The failover status / replay guard must always inspect the real primary.
    // Its result also opens/closes this circuit immediately for normal traffic.
    if (isPrimaryProbeUrl(url, base)) {
      const response = await fetchImpl(input, init);
      return updateFromProbeResponse(response);
    }

    if (quotaBlocked) {
      if (now() < blockedUntil) return syntheticQuotaResponse();
      const ready = await runRecoveryProbe(input, init);
      if (!ready) return syntheticQuotaResponse();
      // The shared read-only probe succeeded.  Only now let this original
      // request touch Supabase, avoiding a split-brain recovery window.
    }

    const response = await fetchImpl(input, init);
    if (response.status === 402) markBlocked();
    return response;
  };

  return {
    fetch: circuitFetch,
    state: () => ({ quotaBlocked, blockedUntil, probing: Boolean(recoveryProbePromise), cooldownMs: cooldown }),
  };
}

const nativeFetch = globalThis.fetch?.bind(globalThis);
const configuredSupabaseUrl = normalizedBase(process.env.SUPABASE_URL);
if (nativeFetch && configuredSupabaseUrl) {
  const circuit = createSupabaseQuotaCircuitFetch({
    fetchImpl: nativeFetch,
    supabaseUrl: configuredSupabaseUrl,
    cooldownMs: process.env.OURHOME_SUPABASE_402_COOLDOWN_MS,
  });
  globalThis.fetch = circuit.fetch;
  console.warn(`[supabase-quota-circuit] armed; REST 402 cooldown ${circuit.state().cooldownMs}ms`);
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  cooldownMsFrom,
  createSupabaseQuotaCircuitFetch,
  isPrimaryProbeUrl,
  isSupabaseRestUrl,
  syntheticQuotaResponse,
};
