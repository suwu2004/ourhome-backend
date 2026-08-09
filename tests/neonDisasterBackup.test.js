const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bridge = fs.readFileSync(path.join(__dirname, '..', 'migrations', '20260809_add_neon_disaster_backup_bridge.sql'), 'utf8');
const schedule = fs.readFileSync(path.join(__dirname, '..', 'migrations', '20260809_schedule_neon_disaster_backup.sql'), 'utf8');

test('Neon disaster backup migration never commits a database credential', () => {
  assert.doesNotMatch(bridge, /postgres(?:ql)?:\/\//i);
  assert.match(bridge, /ourhome_neon_backup_url/);
  assert.match(bridge, /vault\.decrypted_secrets/);
});

test('secret-bearing integration tables are not mirrored to the disaster database', () => {
  assert.doesNotMatch(bridge, /'api_profiles'/);
  assert.doesNotMatch(bridge, /'service_connections'/);
  assert.doesNotMatch(bridge, /'push_subscriptions'/);
  assert.match(bridge, /to_jsonb\(q\) - ''api_key''/);
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
