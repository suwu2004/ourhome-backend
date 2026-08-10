'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const savedSupabaseUrl = process.env.SUPABASE_URL;
delete process.env.SUPABASE_URL;
const {
  createSupabaseQuotaCircuitFetch,
  isPrimaryProbeUrl,
  syntheticQuotaResponse,
} = require('../supabaseQuotaCircuitPatch');
if (savedSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
else process.env.SUPABASE_URL = savedSupabaseUrl;

const BASE = 'https://project.supabase.co';
const DATA_URL = `${BASE}/rest/v1/messages?select=*`;
const PROBE_URL = `${BASE}/rest/v1/settings?select=id&limit=1`;
const AUTH_HEADERS = {
  apikey: 'test-key',
  Authorization: 'Bearer test-key',
};

function jsonResponse(status, body = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('quota circuit recognizes the explicit primary recovery probe', () => {
  assert.equal(isPrimaryProbeUrl(PROBE_URL, BASE), true);
  assert.equal(isPrimaryProbeUrl(DATA_URL, BASE), false);
  const response = syntheticQuotaResponse();
  assert.equal(response.status, 402);
  assert.equal(response.headers.get('X-OurHome-Supabase-Circuit'), 'open');
});

test('one real 402 opens a cooldown so following REST traffic reaches Neon without re-hitting Supabase', async () => {
  let clock = 1_000;
  let upstreamCalls = 0;
  const fetchImpl = async () => {
    upstreamCalls += 1;
    return jsonResponse(402, { message: 'quota' });
  };
  const circuit = createSupabaseQuotaCircuitFetch({
    fetchImpl,
    supabaseUrl: BASE,
    cooldownMs: 30_000,
    now: () => clock,
  });

  const first = await circuit.fetch(DATA_URL, { headers: AUTH_HEADERS });
  assert.equal(first.status, 402);
  assert.equal(upstreamCalls, 1);
  assert.equal(circuit.state().quotaBlocked, true);

  clock += 5_000;
  const second = await circuit.fetch(`${BASE}/rest/v1/settings?select=*`, { headers: AUTH_HEADERS });
  assert.equal(second.status, 402);
  assert.equal(second.headers.get('X-OurHome-Supabase-Circuit'), 'open');
  assert.equal(upstreamCalls, 1, 'cooldown traffic must not touch Supabase again');
});

test('after cooldown, concurrent traffic shares one read-only probe before returning to Supabase', async () => {
  let clock = 10_000;
  let upstreamCalls = 0;
  let primaryReady = false;
  let releaseProbe;
  const probeGate = new Promise(resolve => { releaseProbe = resolve; });

  const fetchImpl = async input => {
    upstreamCalls += 1;
    const url = String(input);
    if (url === PROBE_URL) {
      await probeGate;
      return jsonResponse(primaryReady ? 200 : 402, primaryReady ? [{ id: 'global' }] : { message: 'quota' });
    }
    if (!primaryReady) return jsonResponse(402, { message: 'quota' });
    return jsonResponse(200, [{ id: 1 }]);
  };

  const circuit = createSupabaseQuotaCircuitFetch({
    fetchImpl,
    supabaseUrl: BASE,
    cooldownMs: 30_000,
    now: () => clock,
  });

  await circuit.fetch(DATA_URL, { headers: AUTH_HEADERS });
  assert.equal(upstreamCalls, 1);
  clock += 31_000;
  primaryReady = true;

  const leftPromise = circuit.fetch(DATA_URL, { headers: AUTH_HEADERS });
  const rightPromise = circuit.fetch(`${BASE}/rest/v1/sessions?select=*`, { headers: AUTH_HEADERS });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(upstreamCalls, 2, 'both callers should share one recovery probe');

  releaseProbe();
  const [left, right] = await Promise.all([leftPromise, rightPromise]);
  assert.equal(left.status, 200);
  assert.equal(right.status, 200);
  assert.equal(upstreamCalls, 4, 'one initial 402 + one shared probe + the two original requests');
  assert.equal(circuit.state().quotaBlocked, false);
});

test('the guarded recovery-status probe always checks the real primary and can close the circuit immediately', async () => {
  let clock = 50_000;
  let primaryReady = false;
  const calls = [];
  const fetchImpl = async input => {
    calls.push(String(input));
    if (!primaryReady) return jsonResponse(402, { message: 'quota' });
    return jsonResponse(200, [{ id: 'global' }]);
  };
  const circuit = createSupabaseQuotaCircuitFetch({
    fetchImpl,
    supabaseUrl: BASE,
    cooldownMs: 30_000,
    now: () => clock,
  });

  await circuit.fetch(DATA_URL, { headers: AUTH_HEADERS });
  assert.equal(circuit.state().quotaBlocked, true);

  primaryReady = true;
  clock += 1_000;
  const probe = await circuit.fetch(PROBE_URL, { headers: AUTH_HEADERS });
  assert.equal(probe.status, 200);
  assert.equal(circuit.state().quotaBlocked, false);

  const next = await circuit.fetch(DATA_URL, { headers: AUTH_HEADERS });
  assert.equal(next.status, 200);
  assert.deepEqual(calls, [DATA_URL, PROBE_URL, DATA_URL]);
});
