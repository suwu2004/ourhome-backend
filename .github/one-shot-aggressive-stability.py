from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


# 1) Adaptive Supabase 402 backoff.
quota_path = Path('supabaseQuotaCircuitPatch.js')
quota = quota_path.read_text()
quota = replace_once(
    quota,
    """  let quotaBlocked = false;
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
""",
    """  let quotaBlocked = false;
  let blockedUntil = 0;
  let recoveryProbePromise = null;
  let quotaBackoffLevel = 0;
  let currentCooldownMs = cooldown;

  const cooldownForLevel = level => Math.min(
    MAX_COOLDOWN_MS,
    cooldown * (2 ** Math.max(0, Math.min(16, level) - 1)),
  );

  const markBlocked = ({ escalate = true } = {}) => {
    quotaBlocked = true;
    if (quotaBackoffLevel === 0) quotaBackoffLevel = 1;
    else if (escalate) quotaBackoffLevel = Math.min(16, quotaBackoffLevel + 1);
    currentCooldownMs = cooldownForLevel(quotaBackoffLevel);
    blockedUntil = now() + currentCooldownMs;
  };

  const markReady = () => {
    quotaBlocked = false;
    blockedUntil = 0;
    quotaBackoffLevel = 0;
    currentCooldownMs = cooldown;
  };

  const updateFromProbeResponse = (response, options = {}) => {
    if (response?.status === 402) markBlocked(options);
    else if (response?.ok) markReady();
    return response;
  };
""",
    'adaptive quota state',
)
quota = replace_once(
    quota,
    """        updateFromProbeResponse(response);
        if (!response.ok) {
          if (response.status !== 402) blockedUntil = now() + Math.min(cooldown, 10_000);
""",
    """        updateFromProbeResponse(response, { escalate: true });
        if (!response.ok) {
          if (response.status !== 402) blockedUntil = now() + Math.min(currentCooldownMs, 10_000);
""",
    'adaptive recovery probe',
)
quota = replace_once(
    quota,
    """        blockedUntil = now() + Math.min(cooldown, 10_000);
""",
    """        blockedUntil = now() + Math.min(currentCooldownMs, 10_000);
""",
    'adaptive recovery network error',
)
quota = replace_once(
    quota,
    """      const response = await fetchImpl(input, init);
      return updateFromProbeResponse(response);
""",
    """      const response = await fetchImpl(input, init);
      // A manual recovery check should be immediate, but repeated button taps must
      // not ratchet the automatic backoff higher on their own.
      return updateFromProbeResponse(response, { escalate: false });
""",
    'manual probe does not escalate',
)
quota = replace_once(
    quota,
    """    if (response.status === 402) markBlocked();
    return response;
  };

  return {
    fetch: circuitFetch,
    state: () => ({ quotaBlocked, blockedUntil, probing: Boolean(recoveryProbePromise), cooldownMs: cooldown }),
  };
""",
    """    if (response.status === 402) markBlocked({ escalate: true });
    return response;
  };

  return {
    fetch: circuitFetch,
    state: () => ({
      quotaBlocked,
      blockedUntil,
      probing: Boolean(recoveryProbePromise),
      cooldownMs: cooldown,
      currentCooldownMs,
      backoffLevel: quotaBackoffLevel,
    }),
  };
""",
    'adaptive state marker',
)
quota_path.write_text(quota)


# 2) Expand Neon SQL ordering to the real high-frequency query shapes and coalesce identical GETs.
neon_path = Path('neonFailoverFetchPatch.js')
neon = neon_path.read_text()
neon = replace_once(
    neon,
    """const SQL_READ_ORDER_FIELDS = new Set([
  'created_at', 'updated_at', 'changed_at', 'source_updated_at', 'backed_up_at',
  'remind_at', 'last_run_at', 'claimed_at', 'completed_at', 'retry_after', 'date',
]);
""",
    """const SQL_READ_ORDER_TYPES = new Map([
  ['created_at', 'timestamp'], ['updated_at', 'timestamp'], ['changed_at', 'timestamp'],
  ['source_updated_at', 'timestamp'], ['backed_up_at', 'timestamp'], ['remind_at', 'timestamp'],
  ['last_run_at', 'timestamp'], ['claimed_at', 'timestamp'], ['completed_at', 'timestamp'],
  ['retry_after', 'timestamp'], ['date', 'timestamp'],
  ['is_active', 'boolean'], ['completed', 'boolean'], ['enabled', 'boolean'], ['visible', 'boolean'],
  ['kind', 'text'], ['status', 'text'], ['category', 'text'], ['role', 'text'], ['name', 'text'], ['title', 'text'],
  ['id', 'number'], ['session_id', 'number'], ['sort_order', 'number'], ['position', 'number'],
  ['attempt_count', 'number'], ['version', 'number'], ['amount', 'number'], ['balance', 'number'],
]);

function sqlOrderExpression(field, type) {
  if (type === 'timestamp') {
    return `case when coalesce(payload ->> '${field}', '') ~ '^\\d{4}-\\d{2}-\\d{2}' then (payload ->> '${field}')::timestamptz end`;
  }
  if (type === 'boolean') {
    return `case when payload ->> '${field}' in ('true','false') then (payload ->> '${field}')::boolean end`;
  }
  if (type === 'number') {
    return `case when coalesce(payload ->> '${field}', '') ~ '^-?[0-9]+([.][0-9]+)?$' then (payload ->> '${field}')::numeric end`;
  }
  return `(payload ->> '${field}')`;
}
""",
    'typed SQL ordering',
)
neon = replace_once(
    neon,
    """      const field = safeJsonField(bits[0]);
      if (!field || !SQL_READ_ORDER_FIELDS.has(field)) return null;
      const direction = bits[1] === 'desc' ? 'desc' : 'asc';
""",
    """      const field = safeJsonField(bits[0]);
      const orderType = field ? SQL_READ_ORDER_TYPES.get(field) : null;
      if (!field || !orderType) return null;
      const direction = bits[1] === 'desc' ? 'desc' : 'asc';
""",
    'typed order allowlist',
)
neon = replace_once(
    neon,
    """      orderSql.push(`(payload ->> '${field}')::timestamptz ${direction} ${nulls}`);
""",
    """      orderSql.push(`${sqlOrderExpression(field, orderType)} ${direction} ${nulls}`);
""",
    'typed order SQL expression',
)
neon = neon.replace('/* sql-filtered-v3 */', '/* sql-filtered-coalesced-v4 */')

neon_fallback_old = """async function neonFallback(input, init = {}) {
  if (!pool) return null;
  const url = new URL(requestUrl(input));
  const method = requestMethod(input, init);
  const headers = requestHeaders(input, init);
  const body = await requestJson(input, init);
  const client = await pool.connect();
  try {
    return await handleTableRequest(client, url, method, headers, body);
  } finally {
    client.release();
  }
}
"""
neon_fallback_new = """const inFlightFailoverReads = new Map();

function failoverReadKey(url, method, headers) {
  return [
    method,
    url.href,
    headers.get('accept') || '',
    headers.get('range') || '',
    headers.get('prefer') || '',
  ].join('\\n');
}

async function shareFailoverRead(key, work) {
  let pending = inFlightFailoverReads.get(key);
  if (!pending) {
    pending = Promise.resolve().then(work);
    inFlightFailoverReads.set(key, pending);
    pending.finally(() => {
      if (inFlightFailoverReads.get(key) === pending) inFlightFailoverReads.delete(key);
    }).catch(() => {});
  }
  const response = await pending;
  return typeof response?.clone === 'function' ? response.clone() : response;
}

async function neonFallback(input, init = {}) {
  if (!pool) return null;
  const url = new URL(requestUrl(input));
  const method = requestMethod(input, init);
  const headers = requestHeaders(input, init);
  const body = await requestJson(input, init);
  const execute = async () => {
    const client = await pool.connect();
    try {
      return await handleTableRequest(client, url, method, headers, body);
    } finally {
      client.release();
    }
  };
  if (method === 'GET' || method === 'HEAD') {
    return shareFailoverRead(failoverReadKey(url, method, headers), execute);
  }
  return execute();
}
"""
neon = replace_once(neon, neon_fallback_old, neon_fallback_new, 'coalesce failover reads')
neon = replace_once(neon, "  failoverObjectSignature,\n", "  failoverObjectSignature,\n  failoverReadKey,\n", 'export failover key')
neon = replace_once(neon, "  saveServiceConnection,\n", "  saveServiceConnection,\n  shareFailoverRead,\n", 'export coalescer')
neon_path.write_text(neon)


# 3) Align direct node server.js startup with the same safety guards as npm start, and expose new markers.
runtime_path = Path('runtimeBootstrap.js')
runtime = runtime_path.read_text()
runtime = replace_once(
    runtime,
    """// Render starts the service with `node server.js`. Keep every runtime compatibility
// layer on this one path so direct Render startup and `npm start` behave the same.
// Arm the Supabase-402 fallback before any module captures the global fetch.
// Requiring it again from `npm start` is harmless because Node caches modules.
require('./neonFailoverFetchPatch');
""",
    """// Keep every runtime compatibility layer aligned across direct `node server.js`
// startup and `npm start`. Requiring a patch again from npm preload is harmless
// because Node caches modules. Protect the outer Chat send first, then suppress
// repeated real Supabase REST 402s before the Neon fallback captures fetch.
require('./chatIdempotencyPatch');
require('./supabaseQuotaCircuitPatch');
require('./neonFailoverFetchPatch');
""",
    'direct runtime preload order',
)
runtime = replace_once(
    runtime,
    "console.log('[runtime:bootstrap] Neon quota failover, theater memory, memory, token, native thinking, api audit, non-chat budget, local maintenance, R2 shadow storage, Render fallback front door, diary-summary isolation, zero-cost room knock, resilient Luze learning, bounded helper timeouts, photo retention, context ledger, current-turn guard, autonomy, persona cleanup, vault tool economy, private uploads, toy bear cloud persistence, Luze private learning room, Luze autonomy settings and intimacy patches loaded');",
    "console.log('[runtime:bootstrap] Chat idempotency, adaptive Supabase 402 circuit, Neon quota failover, theater memory, memory, token, native thinking, api audit, non-chat budget, local maintenance, R2 shadow storage, Render fallback front door, diary-summary isolation, zero-cost room knock, resilient Luze learning, bounded helper timeouts, photo retention, context ledger, current-turn guard, autonomy, persona cleanup, vault tool economy, private uploads, toy bear cloud persistence, Luze private learning room, Luze autonomy settings and intimacy patches loaded');",
    'runtime log marker',
)
runtime = replace_once(runtime, "runtime_bootstrap: 'direct-server-start-v2-cost-guard'", "runtime_bootstrap: 'direct-server-start-v4-adaptive-stability'", 'runtime version marker')
runtime = replace_once(runtime, "        toybox: 'toy-bear-gomoku-v4',\n", "        chat_idempotency: 'request-id-single-execution-v1',\n        supabase_quota_circuit: 'rest-402-adaptive-v2',\n        toybox: 'toy-bear-gomoku-v4',\n", 'runtime stability markers')
runtime = replace_once(runtime, "neon_failover_reads: 'sql-filtered-v3'", "neon_failover_reads: 'sql-filtered-coalesced-v4'", 'runtime Neon read marker')
runtime_path.write_text(runtime)


# 4) Regressions for adaptive backoff, real production order shapes, coalescing, and direct-runtime guard parity.
quota_test_path = Path('tests/supabaseQuotaCircuitPatch.test.js')
quota_test = quota_test_path.read_text()
quota_anchor = "test('after cooldown, concurrent traffic shares one read-only probe before returning to Supabase', async () => {"
quota_new_tests = r'''test('repeated real 402 recovery probes back off from 30s toward a five-minute ceiling', async () => {
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

  await circuit.fetch(DATA_URL, { headers: AUTH_HEADERS });
  assert.equal(circuit.state().currentCooldownMs, 30_000);
  assert.equal(circuit.state().backoffLevel, 1);

  clock += 31_000;
  await circuit.fetch(DATA_URL, { headers: AUTH_HEADERS });
  assert.equal(circuit.state().currentCooldownMs, 60_000);
  assert.equal(circuit.state().backoffLevel, 2);
  assert.equal(upstreamCalls, 2, 'one original 402 plus one recovery probe');

  clock += 31_000;
  const stillCooling = await circuit.fetch(DATA_URL, { headers: AUTH_HEADERS });
  assert.equal(stillCooling.headers.get('X-OurHome-Supabase-Circuit'), 'open');
  assert.equal(upstreamCalls, 2, 'adaptive cooldown suppresses premature probes');

  clock += 30_000;
  await circuit.fetch(DATA_URL, { headers: AUTH_HEADERS });
  assert.equal(circuit.state().currentCooldownMs, 120_000);
  assert.equal(circuit.state().backoffLevel, 3);
});

test('manual recovery probes do not make the automatic quota backoff harsher', async () => {
  let clock = 5_000;
  const fetchImpl = async () => jsonResponse(402, { message: 'quota' });
  const circuit = createSupabaseQuotaCircuitFetch({
    fetchImpl,
    supabaseUrl: BASE,
    cooldownMs: 30_000,
    now: () => clock,
  });

  await circuit.fetch(DATA_URL, { headers: AUTH_HEADERS });
  assert.equal(circuit.state().backoffLevel, 1);
  clock += 1_000;
  await circuit.fetch(PROBE_URL, { headers: AUTH_HEADERS });
  assert.equal(circuit.state().backoffLevel, 1);
  assert.equal(circuit.state().currentCooldownMs, 30_000);
});

''' + quota_anchor
if quota_anchor not in quota_test:
    raise SystemExit('quota test anchor missing')
quota_test = quota_test.replace(quota_anchor, quota_new_tests, 1)
quota_test_path.write_text(quota_test)

neon_test_path = Path('tests/neonFailoverFetchPatch.test.js')
neon_test = neon_test_path.read_text()
neon_test = replace_once(neon_test, "  failoverObjectSignature,\n" if "  failoverObjectSignature,\n" in neon_test else "  deriveSecretWrapKey,\n", "  deriveSecretWrapKey,\n  failoverReadKey,\n", 'import failover key') if "failoverReadKey" not in neon_test else neon_test
# The current import list has no failoverObjectSignature; add shareFailoverRead next to saveServiceConnection.
neon_test = replace_once(neon_test, "  saveServiceConnection,\n", "  saveServiceConnection,\n  shareFailoverRead,\n", 'import failover coalescer')
# Update old fast-path marker expectations.
neon_test = neon_test.replace('/sql-filtered-v3/', '/sql-filtered-coalesced-v4/')

profile_old = """test('API profile health reads use SQL-side boolean filtering and limit one', () => {
  const plan = buildSqlReadPlan(new URLSearchParams('is_active=eq.true&limit=1'), new Headers());
  assert.ok(plan);
  assert.deepEqual(plan.values, ['true']);
  assert.equal(plan.limit, 1);
  assert.match(plan.clauses[0], /payload -> 'is_active'/);
});
"""
profile_new = """test('high-frequency API, integration and memo orders stay on the SQL fast path', () => {
  const apiPlan = buildSqlReadPlan(new URLSearchParams('is_active=eq.true&order=is_active.desc,updated_at.desc&limit=1'), new Headers());
  assert.ok(apiPlan);
  assert.deepEqual(apiPlan.values, ['true']);
  assert.equal(apiPlan.limit, 1);
  assert.match(apiPlan.clauses[0], /payload -> 'is_active'/);
  assert.match(apiPlan.orderSql[0], /::boolean desc/);
  assert.match(apiPlan.orderSql[1], /::timestamptz desc/);

  const integrationPlan = buildSqlReadPlan(new URLSearchParams('order=kind.asc,updated_at.desc'), new Headers());
  assert.ok(integrationPlan);
  assert.match(integrationPlan.orderSql[0], /payload ->> 'kind'/);
  assert.match(integrationPlan.orderSql[1], /::timestamptz desc/);

  const memoPlan = buildSqlReadPlan(new URLSearchParams('order=completed.asc,updated_at.desc&limit=60'), new Headers());
  assert.ok(memoPlan);
  assert.match(memoPlan.orderSql[0], /::boolean asc/);
  assert.equal(memoPlan.limit, 60);
});
"""
neon_test = replace_once(neon_test, profile_old, profile_new, 'real production ordering regression')
coalesce_anchor = "test('infers numeric and UUID ids without mutating input', () => {"
coalesce_tests = r'''test('identical in-flight failover reads share one Neon execution and return independent responses', async () => {
  const key = failoverReadKey(
    new URL('https://project.supabase.co/rest/v1/settings?select=*'),
    'GET',
    new Headers({ Accept: 'application/json' }),
  );
  let executions = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const work = async () => {
    executions += 1;
    await gate;
    return new Response(JSON.stringify([{ id: 'global' }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const leftPromise = shareFailoverRead(key, work);
  const rightPromise = shareFailoverRead(key, work);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(executions, 1);
  release();
  const [left, right] = await Promise.all([leftPromise, rightPromise]);
  assert.notEqual(left, right);
  assert.deepEqual(await left.json(), [{ id: 'global' }]);
  assert.deepEqual(await right.json(), [{ id: 'global' }]);
});

''' + coalesce_anchor
if coalesce_anchor not in neon_test:
    raise SystemExit('coalescing test anchor missing')
neon_test = neon_test.replace(coalesce_anchor, coalesce_tests, 1)
neon_test_path.write_text(neon_test)

runtime_test_path = Path('tests/runtimeBootstrap.test.js')
runtime_test = runtime_test_path.read_text()
runtime_test = replace_once(runtime_test, "  assert.match(bootstrapSource, /require\\('\\.\\/neonFailoverFetchPatch'\\);/);\n", "  assert.match(bootstrapSource, /require\\('\\.\\/chatIdempotencyPatch'\\);/);\n  assert.match(bootstrapSource, /require\\('\\.\\/supabaseQuotaCircuitPatch'\\);/);\n  assert.match(bootstrapSource, /require\\('\\.\\/neonFailoverFetchPatch'\\);/);\n", 'runtime preload assertions')
runtime_test = replace_once(
    runtime_test,
    """test('健康接口会暴露新版 direct server start 费用保护标记', () => {
  assert.match(bootstrapSource, /runtime_bootstrap/);
  assert.match(bootstrapSource, /direct-server-start-v2-cost-guard/);
});
""",
    """test('direct server start 会加载稳定性保护且顺序与 npm start 对齐', () => {
  const chat = bootstrapSource.indexOf("require('./chatIdempotencyPatch')");
  const circuit = bootstrapSource.indexOf("require('./supabaseQuotaCircuitPatch')");
  const neon = bootstrapSource.indexOf("require('./neonFailoverFetchPatch')");
  assert.ok(chat >= 0 && chat < circuit && circuit < neon);
  assert.match(bootstrapSource, /direct-server-start-v4-adaptive-stability/);
  assert.match(bootstrapSource, /chat_idempotency: 'request-id-single-execution-v1'/);
  assert.match(bootstrapSource, /supabase_quota_circuit: 'rest-402-adaptive-v2'/);
});
""",
    'runtime stability marker test',
)
runtime_test_path.write_text(runtime_test)

privacy_test_path = Path('tests/runtimeUploadPrivacyGuard.test.js')
privacy_test = privacy_test_path.read_text()
privacy_test = replace_once(privacy_test, "/neon_failover_reads:\\s*'sql-filtered-v3'/", "/neon_failover_reads:\\s*'sql-filtered-coalesced-v4'/", 'Neon health marker regression')
privacy_test_path.write_text(privacy_test)
