const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_CONTEXT_RADIUS,
  normalizeRadius,
  loadMessageContext,
} = require('../chatHistoryContext');

function makeQueryResolver(target, older, newer) {
  return {
    select() { return this; },
    eq() { return this; },
    lt() { this.mode = 'older'; return this; },
    gt() { this.mode = 'newer'; return this; },
    order() { return this; },
    limit() { return this; },
    async maybeSingle() { return { data: target, error: null }; },
    then(resolve, reject) {
      const data = this.mode === 'older' ? older : newer;
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
  };
}

test('normalizeRadius keeps context window bounded', () => {
  assert.equal(DEFAULT_CONTEXT_RADIUS, 1000);
  assert.equal(normalizeRadius(undefined), 1000);
  assert.equal(normalizeRadius(12), 100);
  assert.equal(normalizeRadius(999), 999);
  assert.equal(normalizeRadius(5000), 1000);
  assert.equal(normalizeRadius('800'), 800);
});

test('loadMessageContext returns only a bounded neighborhood around the target', async () => {
  const target = { id: 100, session_id: 7, role: 'user', content: '目标', created_at: '2026-10-01T12:00:00.000Z', visible: true };
  const older = [
    { id: 98, session_id: 7, role: 'assistant', content: '前二', created_at: '2026-10-01T11:58:00.000Z' },
    { id: 99, session_id: 7, role: 'user', content: '前一', created_at: '2026-10-01T11:59:00.000Z' },
  ];
  const newer = [
    { id: 101, session_id: 7, role: 'assistant', content: '后一', created_at: '2026-10-01T12:01:00.000Z' },
  ];
  const supabase = {
    from() {
      const query = makeQueryResolver(target, older, newer);
      query.maybeSingle = async () => ({ data: target, error: null });
      return query;
    },
  };

  const result = await loadMessageContext(supabase, {
    sessionId: 7,
    messageId: 100,
    before: 40,
    after: 40,
  });

  assert.deepEqual(result.messages.map(row => row.id), [98, 99, 100, 101]);
  assert.equal(result.targetId, '100');
  assert.equal(result.hasOlder, false);
  assert.equal(result.hasNewer, false);
  assert.equal(result.nextBefore, '2026-10-01T11:58:00.000Z');
  assert.equal(result.nextAfter, '2026-10-01T12:01:00.000Z');
});
