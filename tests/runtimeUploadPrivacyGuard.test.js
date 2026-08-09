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
  assert.match(bootstrap, /background_recovery:\s*'force-signed-url-refresh-v1'/);
  assert.match(bootstrap, /neon_failover_reads:\s*'unbounded-snapshot-v2'/);
  assert.match(bootstrap, /neon_failover_writes:\s*'journal-v2-vault-rpc'/);
  assert.match(bootstrap, /neon_api_profiles:\s*'secret-read-activate-v1'/);
  assert.match(bootstrap, /storage_failover:\s*'neon-object-spool-v1'/);
});
