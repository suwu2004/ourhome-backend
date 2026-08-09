'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  readR2ShadowConfig,
  encodeObjectKey,
  objectEndpoint,
  createR2ShadowStorage,
  r2ShadowStatus,
} = require('../r2ShadowStorage');

function enabledConfig() {
  return {
    requested: true,
    configured: true,
    enabled: true,
    accountId: 'acct-123',
    apiToken: 'token-secret',
    bucket: 'ourhome-private',
    jurisdiction: 'default',
  };
}

test('R2 shadow stays disabled unless explicitly requested and fully configured', () => {
  assert.equal(readR2ShadowConfig({}).enabled, false);
  assert.equal(r2ShadowStatus({}), 'disabled');
  assert.equal(r2ShadowStatus({ OURHOME_R2_SHADOW_ENABLED: '1' }), 'awaiting-credentials');

  const config = readR2ShadowConfig({
    OURHOME_R2_SHADOW_ENABLED: '1',
    CLOUDFLARE_R2_ACCOUNT_ID: 'acct',
    CLOUDFLARE_R2_API_TOKEN: 'secret',
    CLOUDFLARE_R2_BUCKET: 'bucket',
  });
  assert.equal(config.enabled, true);
  assert.equal(r2ShadowStatus({
    OURHOME_R2_SHADOW_ENABLED: '1',
    CLOUDFLARE_R2_ACCOUNT_ID: 'acct',
    CLOUDFLARE_R2_API_TOKEN: 'secret',
    CLOUDFLARE_R2_BUCKET: 'bucket',
  }), 'enabled');
});

test('R2 object keys keep path slashes while encoding unsafe characters', () => {
  assert.equal(encodeObjectKey('chat/饭 饭.jpg'), 'chat/%E9%A5%AD%20%E9%A5%AD.jpg');
  assert.equal(
    objectEndpoint(enabledConfig(), 'chat/饭 饭.jpg'),
    'https://api.cloudflare.com/client/v4/accounts/acct-123/r2/buckets/ourhome-private/objects/chat/%E9%A5%AD%20%E9%A5%AD.jpg',
  );
});

test('R2 shadow upload uses the Cloudflare object API without exposing credentials in the URL', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ success: true, result: { key: 'chat/a.jpg' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const shadow = createR2ShadowStorage({ config: enabledConfig(), fetchImpl: fakeFetch });
  const result = await shadow.mirrorUpload('chat/a.jpg', Buffer.from('photo'), {
    contentType: 'image/jpeg',
    fileName: 'a.jpg',
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer token-secret');
  assert.equal(calls[0].url.includes('token-secret'), false);
  assert.ok(calls[0].init.body instanceof FormData);
});

test('disabled R2 shadow performs zero network calls', async () => {
  let calls = 0;
  const shadow = createR2ShadowStorage({
    config: { requested: false, configured: false, enabled: false, accountId: '', apiToken: '', bucket: '', jurisdiction: 'default' },
    fetchImpl: async () => { calls += 1; return new Response(null, { status: 200 }); },
  });
  const upload = await shadow.mirrorUpload('a.jpg', Buffer.from('x'));
  const remove = await shadow.mirrorRemove(['a.jpg']);
  assert.equal(upload.skipped, true);
  assert.equal(remove.skipped, true);
  assert.equal(calls, 0);
});

test('private upload patch mirrors only after primary storage succeeds and does not await mirror work', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'r2ShadowPatch.js'), 'utf8');
  assert.match(source, /const result = await originalUpload\(path, body, options\)/);
  assert.match(source, /if \(!result\?\.error && shadow\.enabled\)/);
  assert.match(source, /queueMirror\(`upload \$\{path\}`/);
  assert.doesNotMatch(source, /await shadow\.mirrorUpload/);
  assert.match(source, /replace\(\/Bearer/);
});

test('health marker reports R2 state without account, bucket or token values', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'runtimeBootstrap.js'), 'utf8');
  assert.match(source, /storage_shadow: `cloudflare-r2-\$\{r2ShadowStatus\(\)\}-v1`/);
  assert.doesNotMatch(source, /CLOUDFLARE_R2_API_TOKEN/);
});
