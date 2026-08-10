'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'runtimeBootstrap.js'), 'utf8');

function position(text) {
  const index = source.indexOf(text);
  assert.notEqual(index, -1, `missing runtime preload: ${text}`);
  return index;
}

test('direct runtime loads Chat idempotency and the Supabase quota circuit before Neon captures fetch', () => {
  const chat = position("require('./chatIdempotencyPatch')");
  const circuit = position("require('./supabaseQuotaCircuitPatch')");
  const neon = position("require('./neonFailoverFetchPatch')");
  assert.ok(chat < circuit);
  assert.ok(circuit < neon);
  assert.match(source, /chat_idempotency: 'request-id-single-execution-v1'/);
  assert.match(source, /supabase_quota_circuit: 'rest-402-cooldown-v1'/);
});
