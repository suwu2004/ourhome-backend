'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = '3000';
const {
  FRONTDOOR_PATH,
  API_PROXY_TIMEOUT_MS,
  localApiUrl,
  readProxyBody,
  proxyApiRequest,
} = require('../renderFrontdoorPatch');

function responseMock() {
  return {
    statusCode: 200,
    headers: new Map(),
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers.set(String(name).toLowerCase(), String(value)); },
    send(value) { this.body = value; return this; },
    json(value) { this.body = value; return this; },
    type(value) { this.setHeader('content-type', value); return this; },
  };
}

test('Render fallback lives at /home and keeps a long outer API timeout', () => {
  assert.equal(FRONTDOOR_PATH, '/home');
  assert.ok(API_PROXY_TIMEOUT_MS >= 5 * 60 * 1000);
});

test('same-origin /api URL maps to the existing root backend route', () => {
  assert.equal(
    localApiUrl({ originalUrl: '/api/chat?room=1' }),
    'http://127.0.0.1:3000/chat?room=1',
  );
  assert.equal(
    localApiUrl({ originalUrl: '/api' }),
    'http://127.0.0.1:3000/',
  );
});

test('JSON body is reconstructed after express.json consumed the request stream', async () => {
  const body = await readProxyBody({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { message: 'hello' },
  });
  assert.equal(body.toString('utf8'), '{"message":"hello"}');
});

test('chat POST is forwarded exactly once and never replayed', async () => {
  let calls = 0;
  let seen = null;
  const fetchImpl = async (url, init) => {
    calls += 1;
    seen = { url, init };
    return new Response('{"reply":"ok"}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-ourhome-request-id': 'req-1',
      },
    });
  };
  const req = {
    method: 'POST',
    originalUrl: '/api/chat',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
      'x-ourhome-request-id': 'req-1',
    },
    body: { message: 'hello' },
  };
  const res = responseMock();

  await proxyApiRequest(req, res, { fetchImpl });

  assert.equal(calls, 1);
  assert.equal(seen.url, 'http://127.0.0.1:3000/chat');
  assert.equal(seen.init.method, 'POST');
  assert.equal(Buffer.from(seen.init.body).toString('utf8'), '{"message":"hello"}');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.get('x-ourhome-api-route'), 'render-self-proxy-v1');
  assert.equal(Buffer.from(res.body).toString('utf8'), '{"reply":"ok"}');
});

test('AgentMail webhook is not exposed through the browser /api alias', async () => {
  let calls = 0;
  const req = {
    method: 'POST',
    originalUrl: '/api/agentmail/webhook',
    headers: { 'content-type': 'application/json' },
    body: {},
  };
  const res = responseMock();
  await proxyApiRequest(req, res, { fetchImpl: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(res.statusCode, 404);
});
