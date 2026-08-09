'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  activateApiProfile,
  applyFilters,
  applyOrder,
  createVaultTransaction,
  deleteVaultTransaction,
  decryptedSecret,
  inferDefaults,
  matchFilter,
  projectRows,
  readWindow,
  storeFailoverObjectWithClient,
} = require('../neonFailoverFetchPatch');

test('matches PostgREST scalar, null, range, list, and ilike filters', () => {
  const row = { id: 12, visible: true, parent_id: null, title: 'OurHome 小剧场' };
  assert.equal(matchFilter(row, 'id', 'eq.12'), true);
  assert.equal(matchFilter(row, 'id', 'gte.10'), true);
  assert.equal(matchFilter(row, 'id', 'in.(11,12,13)'), true);
  assert.equal(matchFilter(row, 'parent_id', 'is.null'), true);
  assert.equal(matchFilter(row, 'title', 'ilike.*ourhome*'), true);
});

test('filters, orders, and projects snapshot rows', () => {
  const params = new URLSearchParams('role=eq.user&order=created_at.desc&limit=1&select=id,content');
  const rows = [
    { id: 1, role: 'user', content: 'old', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, role: 'assistant', content: 'reply', created_at: '2026-01-02T00:00:00Z' },
    { id: 3, role: 'user', content: 'new', created_at: '2026-01-03T00:00:00Z' },
  ];
  const filtered = applyFilters(rows, params);
  const ordered = applyOrder(filtered, params.get('order'));
  assert.deepEqual(projectRows(ordered.slice(0, 1), params.get('select')), [{ id: 3, content: 'new' }]);
});

test('a read without limit returns the full snapshot instead of an empty page', () => {
  const unlimited = readWindow(new URLSearchParams('order=updated_at.desc'), new Headers());
  assert.deepEqual(unlimited, { offset: 0, limit: null });

  const explicit = readWindow(new URLSearchParams('offset=5&limit=3'), new Headers());
  assert.deepEqual(explicit, { offset: 5, limit: 3 });

  const ranged = readWindow(new URLSearchParams(), new Headers({ Range: '10-19' }));
  assert.deepEqual(ranged, { offset: 10, limit: 10 });
});

test('infers numeric and UUID ids without mutating input', () => {
  const numeric = inferDefaults({ content: 'hello' }, [{ id: 7, created_at: 'x' }, { id: 9, created_at: 'y' }]);
  assert.equal(numeric.id, 10);
  assert.match(numeric.created_at, /^\d{4}-/);
  const uuid = inferDefaults({ title: 'letter' }, [{ id: '0ddf4fa8-bc42-4e14-9ae7-b02d1309ad75' }]);
  assert.match(uuid.id, /^[0-9a-f-]{36}$/i);
});

test('encrypted failover secrets use columns that exist in the Neon vault snapshot', async () => {
  let query;
  const secret = await decryptedSecret({
    async query(statement) {
      query = statement;
      return { rows: [{ secret: 'kept-private' }] };
    },
  }, { secretId: 'secret-1' });

  assert.equal(secret, 'kept-private');
  assert.match(query.text, /source_updated_at desc nulls last, backed_up_at desc/);
  assert.doesNotMatch(query.text, /order by updated_at/);
});

test('API profile activation is journaled atomically during Supabase quota failover', async () => {
  const profiles = [
    { id: 'profile-a', name: 'A', base_url: 'https://a.example/v1', selected_model: 'model-a', is_active: true, updated_at: 'old' },
    { id: 'profile-b', name: 'B', base_url: 'https://b.example/v1', selected_model: 'model-b', is_active: false, updated_at: 'old' },
  ];
  const journal = [];
  const commands = [];
  const client = {
    async query(statement) {
      if (typeof statement === 'string') {
        commands.push(statement);
        return { rows: [] };
      }
      if (/with latest_changes/.test(statement.text)) {
        return { rows: profiles.map(payload => ({ row_key: String(payload.id), payload })) };
      }
      if (/insert into public\.ourhome_failover_changes/.test(statement.text)) {
        journal.push({
          table: statement.values[0],
          key: statement.values[1],
          operation: statement.values[2],
          payload: JSON.parse(statement.values[3]),
        });
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${statement.text}`);
    },
  };

  const response = await activateApiProfile(client, 'profile-b');
  const activated = await response.json();

  assert.equal(response.status, 200);
  assert.equal(activated.id, 'profile-b');
  assert.equal(activated.is_active, true);
  assert.deepEqual(commands, ['begin', 'commit']);
  assert.deepEqual(journal.map(change => [change.table, change.key, change.payload.is_active]), [
    ['api_profiles', 'profile-a', false],
    ['api_profiles', 'profile-b', true],
  ]);
});

function vaultJournalClient(initialTables) {
  const journal = [];
  const commands = [];
  return {
    journal,
    commands,
    async query(statement) {
      if (typeof statement === 'string') {
        commands.push(statement);
        return { rows: [] };
      }
      if (/with latest_changes/.test(statement.text)) {
        const table = statement.values[0];
        const latest = new Map();
        for (const change of journal.filter(item => item.table === table)) latest.set(change.key, change);
        const base = (initialTables[table] || []).map(payload => ({ key: String(payload.id), payload }));
        const combined = new Map(base.map(item => [item.key, item.payload]));
        for (const change of latest.values()) {
          if (change.operation === 'delete') combined.delete(change.key);
          else combined.set(change.key, change.payload);
        }
        return { rows: [...combined].map(([row_key, payload]) => ({ row_key, payload })) };
      }
      if (/insert into public\.ourhome_failover_changes/.test(statement.text)) {
        journal.push({
          table: statement.values[0],
          key: statement.values[1],
          operation: statement.values[2],
          payload: statement.values[3] == null ? null : JSON.parse(statement.values[3]),
        });
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${statement.text}`);
    },
  };
}

test('vault transaction RPC updates balance and journals every dependent row atomically', async () => {
  const accountId = '11111111-1111-4111-8111-111111111111';
  const groupId = '22222222-2222-4222-8222-222222222222';
  const client = vaultJournalClient({
    vault_accounts: [{ id: accountId, group_id: groupId, name: '钱包', type: 'asset', is_debt: false, balance: 100, updated_at: 'old' }],
    vault_account_groups: [{ id: groupId, name: '微信' }],
    vault_categories: [{ id: '33333333-3333-4333-8333-333333333333', type: 'expense', name: '餐饮' }],
    vault_transactions: [{ id: '44444444-4444-4444-8444-444444444444', created_at: 'old' }],
    vault_account_history: [{ id: '55555555-5555-4555-8555-555555555555', created_at: 'old' }],
    vault_sync_state: [{ id: 'global', initialized: true, updated_at: 'old' }],
  });

  const response = await createVaultTransaction(client, {
    p_date: '2026-08-09', p_type: 'expense', p_amount: 18,
    p_category_name: '餐饮', p_account_id: accountId, p_source: 'manual',
  });
  const transactionId = await response.json();

  assert.match(transactionId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(client.commands, ['begin', 'commit']);
  assert.equal(client.journal.find(item => item.table === 'vault_accounts').payload.balance, 82);
  assert.equal(client.journal.find(item => item.table === 'vault_transactions').payload.amount, 18);
  assert.equal(client.journal.find(item => item.table === 'vault_account_history').payload.change, -18);
  assert.equal(client.journal.find(item => item.table === 'vault_sync_state').payload.initialized, true);
});

test('vault transaction delete restores the account and records a logical delete', async () => {
  const accountId = '11111111-1111-4111-8111-111111111111';
  const transactionId = '44444444-4444-4444-8444-444444444444';
  const client = vaultJournalClient({
    vault_accounts: [{ id: accountId, name: '钱包', type: 'asset', is_debt: false, balance: 82, updated_at: 'old' }],
    vault_transactions: [{ id: transactionId, account_id: accountId, type: 'expense', amount: 18, created_at: 'old' }],
    vault_account_history: [{ id: '55555555-5555-4555-8555-555555555555', created_at: 'old' }],
    vault_sync_state: [{ id: 'global', initialized: true, updated_at: 'old' }],
  });

  const response = await deleteVaultTransaction(client, { p_transaction_id: transactionId });
  assert.equal(await response.json(), true);
  assert.equal(client.journal.find(item => item.table === 'vault_accounts').payload.balance, 100);
  assert.equal(client.journal.find(item => item.table === 'vault_transactions').operation, 'delete');
  assert.deepEqual(client.commands, ['begin', 'commit']);
});

test('Neon object spool keeps image bytes and metadata together', async () => {
  let inserted;
  const client = {
    async query(statement) {
      if (/sum\(size_bytes\)/.test(statement.text)) return { rows: [{ total: 0 }] };
      if (/insert into public\.ourhome_failover_objects/.test(statement.text)) {
        inserted = statement.values;
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${statement.text}`);
    },
  };
  const result = await storeFailoverObjectWithClient(client, {
    objectKey: 'photo-a.jpg', contentType: 'image/jpeg', originalName: '檀檀.jpg', body: Buffer.from('image-bytes'),
  });
  assert.equal(result.objectKey, 'photo-a.jpg');
  assert.equal(result.size, 11);
  assert.equal(inserted[0], 'photo-a.jpg');
  assert.equal(inserted[2], 'image/jpeg');
  assert.deepEqual(inserted[5], Buffer.from('image-bytes'));
});
