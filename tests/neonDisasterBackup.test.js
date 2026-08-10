const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bridge = fs.readFileSync(path.join(__dirname, '..', 'migrations', '20260809_add_neon_disaster_backup_bridge.sql'), 'utf8');
const extension = fs.readFileSync(path.join(__dirname, '..', 'migrations', '20260809_expand_neon_disaster_backup.sql'), 'utf8');
const schedule = fs.readFileSync(path.join(__dirname, '..', 'migrations', '20260809_schedule_neon_disaster_backup.sql'), 'utf8');
const pendingSecrets = fs.readFileSync(path.join(__dirname, '..', 'migrations', '20260809_add_neon_failover_secret_changes.sql'), 'utf8');
const stableSecretWrap = fs.readFileSync(path.join(__dirname, '..', 'migrations', '20260810_stabilize_neon_secret_wrap_v2.sql'), 'utf8');

test('Neon disaster backup migration never commits a database credential', () => {
  assert.doesNotMatch(bridge, /postgres(?:ql)?:\/\//i);
  assert.match(bridge, /ourhome_neon_backup_url/);
  assert.match(bridge, /vault\.decrypted_secrets/);
});

test('the base snapshot never mirrors secret-bearing integration tables', () => {
  assert.doesNotMatch(bridge, /'api_profiles'/);
  assert.doesNotMatch(bridge, /'service_connections'/);
  assert.doesNotMatch(bridge, /'push_subscriptions'/);
  assert.match(bridge, /to_jsonb\(q\) - ''api_key''/);
});

test('the extended snapshot encrypts runtime secrets and still excludes device push credentials', () => {
  assert.match(extension, /'api_profiles'/);
  assert.match(extension, /'service_connections'/);
  assert.match(extension, /'api_call_logs'/);
  assert.match(extension, /pgp_sym_encrypt/);
  assert.match(extension, /digest\(neon_url/);
  assert.match(extension, /ourhome_failover_secrets/);
  assert.doesNotMatch(extension, /extra_tables[^;]*'push_subscriptions'/s);
  assert.doesNotMatch(extension, /ourhome_neon_backup_url'\s*\)/);
});

test('credentials changed during failover stay encrypted in a snapshot-independent journal', () => {
  assert.match(pendingSecrets, /ourhome_failover_secret_changes/);
  assert.match(pendingSecrets, /ciphertext bytea/);
  assert.match(pendingSecrets, /operation in \('upsert', 'delete'\)/);
  assert.match(pendingSecrets, /revoke all/);
  assert.doesNotMatch(pendingSecrets, /postgres(?:ql)?:\/\//i);
});

test('V2 secret wrapping is stable across equivalent Neon connection URLs', () => {
  assert.doesNotMatch(stableSecretWrap, /postgres(?:ql)?:\/\/[^'\s]*@/i);
  assert.match(stableSecretWrap, /split_part\(btrim\(p_neon_url\), '\?', 1\)/);
  assert.match(stableSecretWrap, /replace\([^;]*'-pooler\.', '\.'\)/s);
  assert.match(stableSecretWrap, /'\^postgres:\/\/'/);
  assert.match(stableSecretWrap, /'\/\+\$'/);
  assert.match(stableSecretWrap, /ourhome-neon-failover-secrets-v2/);
});

test('V2 backup replaces ciphertext transactionally and keeps the existing scheduled entry point', () => {
  assert.match(stableSecretWrap, /rename to ourhome_backup_extended_to_neon_legacy/);
  assert.match(stableSecretWrap, /snapshot_result := public\.ourhome_backup_extended_to_neon_legacy\(\)/);
  assert.match(stableSecretWrap, /secret_result := public\.ourhome_backup_neon_secrets_v2\(\)/);
  assert.match(stableSecretWrap, /delete from public\.ourhome_failover_secrets/);
  assert.match(stableSecretWrap, /dblink_exec\(conn_name, 'begin'\)/);
  assert.match(stableSecretWrap, /dblink_exec\(conn_name, 'commit'\)/);
  assert.match(stableSecretWrap, /dblink_exec\(conn_name, 'rollback'\)/);
});

test('backup is single-flight and each remote table replacement is transactional', () => {
  assert.match(bridge, /pg_try_advisory_xact_lock/);
  assert.match(bridge, /dblink_exec\(conn_name, 'begin'\)/);
  assert.match(bridge, /dblink_exec\(conn_name, 'commit'\)/);
  assert.match(bridge, /dblink_exec\(conn_name, 'rollback'\)/);
});

test('daily disaster snapshot is scheduled once per day, not on a tight polling loop', () => {
  assert.match(schedule, /20 20 \* \* \*/);
  assert.match(schedule, /ourhome-neon-disaster-backup/);
  assert.doesNotMatch(schedule, /\*\/\d+/);
});
