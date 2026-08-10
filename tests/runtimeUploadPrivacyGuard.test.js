'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function source(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('main runtime installs the private uploads guard on its Supabase client', () => {
  const runtime = source('runtimeConfig.js');
  assert.match(runtime, /require\('\.\/privateUploads'\)/);
  assert.match(runtime, /installPrivateBucketGuard\(supabase\);/);

  const guardAt = runtime.indexOf('installPrivateBucketGuard(supabase);');
  const assistantsAt = runtime.indexOf('createReadingAssistant({ supabase })');
  assert.ok(guardAt >= 0 && assistantsAt > guardAt, 'privacy guard must install before runtime helpers use the client');
});

test('production health exposes the main-client upload privacy guard', () => {
  const bootstrap = source('runtimeBootstrap.js');
  assert.match(bootstrap, /upload_privacy:\s*'main-client-private-guard-v1'/);
  assert.match(bootstrap, /background_recovery:\s*'quota-cooldown-signed-url-v2'/);
  assert.match(bootstrap, /neon_failover_reads:\s*'unbounded-snapshot-v2'/);
  assert.match(bootstrap, /neon_failover_writes:\s*'journal-v4-vault-ledger-automation-rpc'/);
  assert.match(bootstrap, /neon_api_profiles:\s*'encrypted-secret-write-v3-normalized-wrap'/);
  assert.match(bootstrap, /neon_secret_wrap:\s*'normalized-v2-transition-v1'/);
  assert.match(bootstrap, /neon_replay:\s*'primary-probe-idempotent-v1'/);
  assert.match(bootstrap, /api_model_catalog:\s*'saved-model-fallback-v1'/);
  assert.match(bootstrap, /storage_failover:\s*'neon-object-spool-v1'/);
});
