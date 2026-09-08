'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
function source(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }

test('main runtime installs the private uploads guard on its Supabase client', () => {
  const runtime = source('runtimeConfig.js');
  assert.match(runtime, /require\('\.\/privateUploads'\)/);
  assert.match(runtime, /installPrivateBucketGuard\(supabase\);/);
  const guardAt = runtime.indexOf('installPrivateBucketGuard(supabase);');
  const assistantsAt = runtime.indexOf('createReadingAssistant({ supabase })');
  assert.ok(guardAt >= 0 && assistantsAt > guardAt, 'privacy guard must install before runtime helpers use the client');
});

test('production runtime keeps privacy and failover modules wired without retired browser-facing markers', () => {
  const bootstrap = source('runtimeBootstrap.js');
  for (const marker of [
    'neonFailoverFetchPatch', 'photoRetentionPatch', 'photoMemoryVisionPatch',
    'supabaseQuotaCircuitPatch', 'contextLedgerPatch', 'chatCurrentTurnGuardPatch',
  ]) assert.match(bootstrap, new RegExp(`require\\('\\./${marker}'\\)`));
  assert.doesNotMatch(bootstrap, /upload_privacy:/);
  assert.doesNotMatch(bootstrap, /background_recovery:/);
});
