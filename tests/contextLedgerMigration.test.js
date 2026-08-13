const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260813_fix_context_ledger_version_ambiguity.sql'),
  'utf8',
);

test('context ledger migration qualifies the optimistic version counter', () => {
  assert.match(migration, /update public\.session_context_ledgers as ledger/);
  assert.match(migration, /version = ledger\.version \+ 1/);
  assert.match(migration, /where ledger\.session_id = p_session_id/);
  assert.doesNotMatch(migration, /version = version \+ 1/);
});

test('context ledger RPC stays private to the server role', () => {
  assert.match(migration, /set search_path = pg_catalog, public/);
  assert.match(migration, /revoke all on function public\.ourhome_context_ledger_commit[\s\S]*from public/);
  assert.match(migration, /grant execute on function public\.ourhome_context_ledger_commit[\s\S]*to service_role/);
});
