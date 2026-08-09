'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PORT = '3000';
const {
  FRONTDOOR_PATH,
  API_PROXY_TIMEOUT_MS,
  requestPathname,
  isPublicFrontdoorPath,
  localFrontendFile,
  readLocalFrontend,
  renderFrontdoorStatus,
  writePublicResponse,
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

function nativeResponseMock() {
  return {
    statusCode: 200,
    headers: new Map(),
    body: null,
    setHeader(name, value) { this.headers.set(String(name).toLowerCase(), String(value)); },
    end(value) { this.body = value; },
  };
}

test('Render fallback lives at /home and keeps a long outer API timeout', () => {
  assert.equal(FRONTDOOR_PATH, '/home');
  assert.ok(API_PROXY_TIMEOUT_MS >= 5 * 60 * 1000);
});

test('only public shell paths bypass the normal login middleware', () => {
  for (const pathname of ['/home', '/home/', '/assets/index.js', '/manifest.json', '/icon-192.png', '/ourhome-sw.js']) {
    assert.equal(isPublicFrontdoorPath(pathname), true, pathname);
  }
  for (const pathname of ['/', '/chat', '/settings', '/api', '/api/chat', '/agentmail/webhook']) {
    assert.equal(isPublicFrontdoorPath(pathname), false, pathname);
  }
  assert.equal(requestPathname({ url: '/home?from=test' }), '/home');
});

test('early public shell response works before Express response helpers exist', () => {
  const res = nativeResponseMock();
  writePublicResponse(res, 200, Buffer.from('<html>home</html>'), {
    'Content-Type': 'text/html; charset=utf-8',
    'X-OurHome-Frontdoor': 'test',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('x-ourhome-frontdoor'), 'test');
  assert.equal(Buffer.from(res.body).toString('utf8'), '<html>home</html>');
});

test('public shell interception never depends on Express-only response helpers', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderFrontdoorPatch.js'), 'utf8');
  const publicStart = source.indexOf('function writePublicResponse');
  const privateStart = source.indexOf('function forwardedHeaders');
  assert.ok(publicStart >= 0 && privateStart > publicStart);
  const publicSource = source.slice(publicStart, privateStart);
  assert.doesNotMatch(publicSource, /res\.(?:status|send|json|type)\s*\(/);
  assert.match(publicSource, /res\.statusCode\s*=/);
  assert.match(publicSource, /res\.end\(/);
});

test('local Render build serves index and hashed assets without Vercel', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ourhome-render-frontdoor-'));
  try {
    fs.mkdirSync(path.join(rootDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'index.html'), '<!doctype html><title>OurHome</title>');
    fs.writeFileSync(path.join(rootDir, 'assets', 'index-test.js'), 'console.log("home")');

    assert.equal(renderFrontdoorStatus(rootDir), 'local-build');
    assert.equal(localFrontendFile('/', rootDir), path.join(rootDir, 'index.html'));

    const index = await readLocalFrontend('/', { rootDir });
    const asset = await readLocalFrontend('/assets/index-test.js', { rootDir });
    assert.equal(index.local, true);
    assert.match(index.body.toString('utf8'), /OurHome/);
    assert.match(index.contentType, /text\/html/);
    assert.equal(asset.local, true);
    assert.match(asset.contentType, /javascript/);
    assert.match(asset.cacheControl, /immutable/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('local frontend path mapping rejects non-shell and traversal-shaped paths', () => {
  const rootDir = path.join(os.tmpdir(), 'ourhome-frontdoor-root');
  assert.equal(localFrontendFile('/api/chat', rootDir), null);
  assert.equal(localFrontendFile('/assets/../../server.js', rootDir), null);
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