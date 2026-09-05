'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const PATCH = require.resolve('../modelCallSingleflightPatch');

function loadPatchWithFetch(fakeFetch) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  delete require.cache[PATCH];
  const helpers = require(PATCH);
  return () => {
    delete require.cache[PATCH];
    globalThis.fetch = originalFetch;
  };
}

test('singleflight coalesces identical concurrent non-streaming model calls', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });

  const restore = loadPatchWithFetch(async () => {
    calls += 1;
    await gate;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  try {
    const init = {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'x-ourhome-call-purpose': 'chat' },
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }),
    };
    const p1 = fetch('https://example.test/v1/chat/completions', init);
    const p2 = fetch('https://example.test/v1/chat/completions', { ...init, headers: { ...init.headers } });
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(calls, 1);
    assert.deepEqual(await r1.json(), { ok: true });
    assert.deepEqual(await r2.json(), { ok: true });
  } finally {
    restore();
  }
});

test('singleflight does not intercept streaming model calls', async () => {
  let calls = 0;
  const restore = loadPatchWithFetch(async () => {
    calls += 1;
    return new Response('stream-body', { status: 200 });
  });

  try {
    const response = await fetch('https://example.test/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'test-model', messages: [], stream: true }),
    });
    assert.equal(calls, 1);
    assert.equal(await response.text(), 'stream-body');
  } finally {
    restore();
  }
});

test('singleflight ignores malformed or non-model requests', () => {
  assert.equal(require(PATCH).isModelRequest('https://example.test/v1/messages', {
    method: 'POST',
    body: '{not-json}',
  }), false);
  assert.equal(require(PATCH).isModelRequest('https://example.test/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ messages: [] }),
  }), false);
});
