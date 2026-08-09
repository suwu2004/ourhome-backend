'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { conflictColumn, primaryRowIsNewer } = require('../neonFailoverReplay');

test('replay chooses stable primary keys and rejects ambiguous rows', () => {
  assert.equal(conflictColumn({ payload: { id: 7 } }), 'id');
  assert.equal(conflictColumn({ payload: { session_id: 'global' } }), 'session_id');
  assert.equal(conflictColumn({ operation: 'delete', row_key: '7', payload: null }), 'id');
  assert.throws(() => conflictColumn({ table_name: 'unknown', row_key: 'x', payload: {} }), /没有可安全回迁的主键/);
});

test('a newer primary row pauses replay instead of overwriting it', () => {
  assert.equal(primaryRowIsNewer(
    { updated_at: '2026-08-10T00:00:00Z' },
    { changed_at: '2026-08-09T00:00:00Z', payload: { updated_at: '2026-08-09T00:00:00Z' } },
  ), true);
  assert.equal(primaryRowIsNewer(
    { updated_at: '2026-08-08T00:00:00Z' },
    { changed_at: '2026-08-09T00:00:00Z', payload: { updated_at: '2026-08-09T00:00:00Z' } },
  ), false);
});

test('replay probes primary Supabase and never marks secrets as ordinary rows', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'neonFailoverReplay.js'), 'utf8');
  assert.match(source, /assertPrimaryReady/);
  assert.match(source, /pending_secrets > 0/);
  assert.match(source, /resolution=merge-duplicates,return=minimal/);
  assert.match(source, /primaryRowIsNewer/);
  assert.match(source, /已保留 Neon 原件并暂停自动回迁/);
  assert.match(source, /where table_name=\$1 and row_key=\$2 and applied_to_supabase_at is null/);
});

test('production replay bypasses the Neon fetch fallback when probing Supabase', () => {
  const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  const failover = fs.readFileSync(path.resolve(__dirname, '..', 'neonFailoverFetchPatch.js'), 'utf8');
  assert.match(failover, /primaryFetch: upstreamFetch/);
  assert.match(server, /createNeonFailoverReplay\(\{ fetchImpl: primaryFetch \}\)/);
});
