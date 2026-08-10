'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  activateApiProfile,
  applyFilters,
  applyOrder,
  claimDailyJournal,
  commitContextLedger,
  createVaultTransaction,
  deleteVaultTransaction,
  deleteApiProfile,
  deleteServiceConnection,
  decryptedSecret,
  deriveSecretWrapKey,
  inferDefaults,
  matchFilter,
  normalizeNeonConnectionIdentity,
  projectRows,
  queryWithWrapKeyFallback,
  readWindow,
  saveAgentMailWebhookSecret,
  saveApiProfile,
  saveServiceConnection,
  storeFailoverObjectWithClient,
  transitionIntimacyFlow,
} = require('../neonFailoverFetchPatch');

test('normalizes equivalent Neon pooled and direct connection URLs to one V2 key', () => {
  const pooled = 'postgresql://owner:secret@ep-home-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
  const direct = 'postgres://owner:secret@ep-home.us-west-2.aws.neon.tech/neondb?sslmode=require';

  assert.equal(normalizeNeonConnectionIdentity(pooled), normalizeNeonConnectionIdentity(direct));
  assert.equal(
    deriveSecretWrapKey(normalizeNeonConnectionIdentity(pooled), 'v2'),
    deriveSecretWrapKey(normalizeNeonConnectionIdentity(direct), 'v2'),
  );
  assert.notEqual(deriveSecretWrapKey(pooled, 'v1'), deriveSecretWrapKey(direct, 'v1'));
});

test('secret decryption retries transition keys without exposing the ciphertext', async () => {
  const attempts = [];
  const result = await queryWithWrapKeyFallback({
    async query(statement) {
      attempts.push(statement.values.at(-1));
      if (statement.values.at(-1) === 'new-key') throw new Error('Wrong key or corrupt data');
      return { rows: [{ secret: 'kept-private' }] };
    },
  }, { text: 'select pgp_sym_decrypt(ciphertext, $2)', values: ['secret-id'] }, ['new-key', 'legacy-key']);

  assert.deepEqual(attempts, ['new-key', 'legacy-key']);
  assert.equal(result.rows[0].secret, 'kept-private');
});

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
  const queries = [];
  const secret = await decryptedSecret({
    async query(statement) {
      queries.push(statement);
      if (/ourhome_failover_secret_changes/.test(statement.text)) return { rows: [] };
      return { rows: [{ secret: 'kept-private' }] };
    },
  }, { secretId: 'secret-1' });

  assert.equal(secret, 'kept-private');
  assert.match(queries[1].text, /source_updated_at desc nulls last, backed_up_at desc/);
  assert.doesNotMatch(queries[1].text, /order by updated_at/);
});

test('pending encrypted secret changes override snapshots, including deletion tombstones', async () => {
  const updated = await decryptedSecret({
    async query(statement) {
      if (/ourhome_failover_secret_changes/.test(statement.text)) {
        return { rows: [{ operation: 'upsert', secret: 'new-private-key' }] };
      }
      throw new Error('snapshot should not be read after a pending secret update');
    },
  }, { secretId: 'secret-1' });
  assert.equal(updated, 'new-private-key');

  const deleted = await decryptedSecret({
    async query(statement) {
      if (/ourhome_failover_secret_changes/.test(statement.text)) {
        return { rows: [{ operation: 'delete', secret: null }] };
      }
      throw new Error('snapshot should not resurrect a deleted secret');
    },
  }, { secretId: 'secret-1' });
  assert.equal(deleted, null);
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
  const secretChanges = [];
  const commands = [];
  return {
    journal,
    secretChanges,
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
      if (/insert into public\.ourhome_failover_secret_changes/.test(statement.text)) {
        secretChanges.push({
          id: statement.values[0],
          name: statement.values[1],
          operation: /'delete'/.test(statement.text) ? 'delete' : 'upsert',
          secret: statement.values[2] || null,
        });
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${statement.text}`);
    },
  };
}

test('daily journal claims remain idempotent and retry stale runs in Neon', async () => {
  const client = vaultJournalClient({ daily_journal_runs: [] });
  const first = await claimDailyJournal(client, { p_run_date: '2026-08-10' });
  const duplicate = await claimDailyJournal(client, { p_run_date: '2026-08-10' });

  assert.equal(await first.json(), true);
  assert.equal(await duplicate.json(), false);
  assert.equal(client.journal.filter(change => change.table === 'daily_journal_runs').length, 1);

  const retryClient = vaultJournalClient({
    daily_journal_runs: [{ run_date: '2026-08-10', status: 'partial', attempt_count: 2, claimed_at: 'old' }],
  });
  const retry = await claimDailyJournal(retryClient, { p_run_date: '2026-08-10' });
  assert.equal(await retry.json(), true);
  assert.equal(retryClient.journal[0].payload.attempt_count, 3);
  assert.equal(retryClient.journal[0].payload.status, 'running');
});

test('context ledger commits preserve optimistic concurrency in Neon', async () => {
  const client = vaultJournalClient({ session_context_ledgers: [] });
  const created = await commitContextLedger(client, {
    p_session_id: 22,
    p_expected_version: 0,
    p_summary: 'continuity',
    p_summarized_through_message_id: 100,
    p_summarized_message_count: 10,
    p_summarized_chars: 500,
  });
  const createdRows = await created.json();
  assert.equal(createdRows[0].version, 1);
  assert.equal(createdRows[0].summary, 'continuity');

  const conflict = await commitContextLedger(client, {
    p_session_id: 22,
    p_expected_version: 0,
    p_summary: 'stale writer',
  });
  assert.deepEqual(await conflict.json(), []);
});

test('intimacy state transitions keep version checks during quota failover', async () => {
  const client = vaultJournalClient({ intimacy_flow_states: [] });
  const created = await transitionIntimacyFlow(client, {
    p_session_id: 22,
    p_expected_version: 0,
    p_next_state: { phase: 'steady' },
  });
  assert.deepEqual(await created.json(), {
    session_id: 22,
    version: 1,
    state: { phase: 'steady' },
    updated_at: client.journal[0].payload.updated_at,
  });

  const conflict = await transitionIntimacyFlow(client, {
    p_session_id: 22,
    p_expected_version: 0,
    p_next_state: { phase: 'stale' },
  });
  assert.equal(await conflict.text(), '');
});

test('API profile create, activation, settings update and deletion stay atomic in Neon', async () => {
  const client = vaultJournalClient({
    api_profiles: [{
      id: '11111111-1111-4111-8111-111111111111', name: '旧线路',
      base_url: 'https://old.example/v1', selected_model: 'old-model',
      api_key_secret_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      is_active: true, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
    }],
    settings: [{
      id: '22222222-2222-4222-8222-222222222222', session_id: 'global',
      api_base_url: 'https://old.example/v1', selected_model: 'old-model', updated_at: 'old',
    }],
  });

  const createdResponse = await saveApiProfile(client, {
    p_name: '新线路', p_base_url: 'https://new.example/v1/', p_api_key: 'private-key',
    p_selected_model: 'new-model', p_make_active: true,
  });
  const created = await createdResponse.json();
  assert.equal(created.base_url, 'https://new.example/v1');
  assert.equal(created.is_active, true);
  assert.equal(client.secretChanges[0].name, `ourhome_api_${created.id}`);
  assert.equal(client.secretChanges[0].operation, 'upsert');
  assert.equal(client.journal.find(change => change.table === 'settings').payload.selected_model, 'new-model');
  assert.equal(client.journal.filter(change => change.table === 'api_profiles').length, 2);

  const deletedResponse = await deleteApiProfile(client, created.id);
  assert.equal(await deletedResponse.text(), '');
  assert.equal(client.secretChanges.at(-1).operation, 'delete');
  assert.equal(client.journal.at(-3).operation, 'delete');
  assert.deepEqual(client.commands, ['begin', 'commit', 'begin', 'commit']);
});

test('service connections and AgentMail webhook secrets use the encrypted Neon journal', async () => {
  const client = vaultJournalClient({ service_connections: [] });
  const savedResponse = await saveServiceConnection(client, {
    p_kind: 'agentmail', p_name: '陆泽邮箱', p_url: 'https://api.agentmail.to',
    p_secret: 'mailbox-key', p_enabled: true, p_config: {},
  });
  const saved = await savedResponse.json();
  assert.equal(saved.kind, 'agentmail');
  assert.equal(client.secretChanges[0].name, `ourhome_connection_${saved.id}`);

  const webhookResponse = await saveAgentMailWebhookSecret(client, {
    p_connection_id: saved.id, p_secret: 'webhook-key',
  });
  const webhookSecretId = await webhookResponse.json();
  assert.match(webhookSecretId, /^[0-9a-f-]{36}$/i);
  assert.equal(client.secretChanges.at(-1).name, `ourhome_agentmail_webhook_${saved.id}`);

  const deletedResponse = await deleteServiceConnection(client, saved.id);
  assert.equal(await deletedResponse.text(), '');
  assert.equal(client.secretChanges.at(-1).operation, 'delete');
  assert.equal(client.journal.at(-1).operation, 'delete');
});

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
