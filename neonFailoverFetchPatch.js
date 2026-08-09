'use strict';

// Emergency data-plane fallback for Supabase quota responses.
// Supabase remains authoritative. Neon stores a read-only snapshot plus an
// append-only change journal that can be replayed into Supabase after recovery.

const crypto = require('crypto');
const { Pool } = require('pg');

const upstreamFetch = globalThis.fetch;
const enabled = /^(1|true|yes|on)$/i.test(String(process.env.OURHOME_NEON_FAILOVER_ENABLED || ''));
const connectionString = String(process.env.OURHOME_NEON_DATABASE_URL || '').trim();
const secretWrapKey = connectionString
  ? crypto.createHash('sha256').update(`${connectionString}:ourhome-neon-failover-secrets-v1`).digest('hex')
  : '';
const pool = enabled && connectionString
  ? new Pool({ connectionString, max: 4, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 8_000 })
  : null;
const ROW_KEY = Symbol('ourhome-neon-row-key');
const MAX_FAILOVER_OBJECT_BYTES = 12 * 1024 * 1024;
const MAX_FAILOVER_OBJECT_TOTAL_BYTES = 220 * 1024 * 1024;

function isSupabaseRestUrl(value) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  return Boolean(base && String(value || '').startsWith(`${base}/rest/v1/`));
}

function requestUrl(input) {
  return typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
}

function requestMethod(input, init = {}) {
  return String(init.method || input?.method || 'GET').toUpperCase();
}

function requestHeaders(input, init = {}) {
  return new Headers(init.headers || input?.headers || undefined);
}

async function requestJson(input, init = {}) {
  const body = init.body !== undefined ? init.body : input?.body;
  if (body == null) return null;
  if (typeof body === 'string') return body ? JSON.parse(body) : null;
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) return JSON.parse(Buffer.from(body).toString('utf8'));
  return null;
}

function scalar(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function comparable(value) {
  if (value == null) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const number = Number(value);
  if (String(value).trim() !== '' && Number.isFinite(number)) return number;
  const date = Date.parse(value);
  if (/^\d{4}-\d\d-\d\d(?:T|$)/.test(String(value)) && Number.isFinite(date)) return date;
  return String(value);
}

function parseInList(raw) {
  const inner = String(raw || '').replace(/^\(/, '').replace(/\)$/, '');
  if (!inner) return [];
  return inner.split(',').map(item => decodeURIComponent(item).replace(/^"|"$/g, '')).map(scalar);
}

function matchFilter(row, column, expression) {
  const dot = String(expression || '').indexOf('.');
  const op = dot < 0 ? 'eq' : expression.slice(0, dot);
  const raw = dot < 0 ? expression : expression.slice(dot + 1);
  const actual = row?.[column];
  const expected = scalar(decodeURIComponent(raw));
  if (op === 'eq') return comparable(actual) === comparable(expected);
  if (op === 'neq') return comparable(actual) !== comparable(expected);
  if (op === 'is') return raw === 'null' ? actual == null : comparable(actual) === comparable(expected);
  if (op === 'in') return parseInList(raw).some(value => comparable(actual) === comparable(value));
  if (op === 'gt') return comparable(actual) > comparable(expected);
  if (op === 'gte') return comparable(actual) >= comparable(expected);
  if (op === 'lt') return comparable(actual) < comparable(expected);
  if (op === 'lte') return comparable(actual) <= comparable(expected);
  if (op === 'ilike' || op === 'like') {
    const escaped = String(expected).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*');
    return new RegExp(`^${escaped}$`, op === 'ilike' ? 'i' : '').test(String(actual ?? ''));
  }
  return true;
}

function applyFilters(rows, params) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
  let output = rows;
  for (const [column, expression] of params.entries()) {
    if (reserved.has(column) || column === 'and' || column === 'or') continue;
    output = output.filter(row => matchFilter(row, column, expression));
  }
  return output;
}

function applyOrder(rows, value) {
  const clauses = String(value || '').split(',').filter(Boolean).map(part => {
    const bits = part.split('.');
    return { column: bits[0], ascending: bits[1] !== 'desc', nullsFirst: bits.includes('nullsfirst') };
  });
  if (!clauses.length) return rows;
  return [...rows].sort((left, right) => {
    for (const clause of clauses) {
      const a = left?.[clause.column];
      const b = right?.[clause.column];
      if (a == null || b == null) {
        if (a == null && b == null) continue;
        const result = a == null ? (clause.nullsFirst ? -1 : 1) : (clause.nullsFirst ? 1 : -1);
        return clause.ascending ? result : -result;
      }
      const av = comparable(a);
      const bv = comparable(b);
      if (av < bv) return clause.ascending ? -1 : 1;
      if (av > bv) return clause.ascending ? 1 : -1;
    }
    return 0;
  });
}

function selectedColumns(value) {
  const raw = String(value || '*');
  if (!raw || raw === '*' || raw.includes('(')) return null;
  return raw.split(',').map(item => item.trim()).filter(item => /^[a-zA-Z_][\w]*$/.test(item));
}

function projectRows(rows, select) {
  const columns = selectedColumns(select);
  if (!columns) return rows;
  return rows.map(row => Object.fromEntries(columns.map(column => [column, row?.[column] ?? null])));
}

function inferDefaults(row, sampleRows) {
  const next = { ...(row || {}) };
  const now = new Date().toISOString();
  const sample = sampleRows.find(Boolean) || {};
  if (next.id == null && Object.prototype.hasOwnProperty.call(sample, 'id')) {
    if (typeof sample.id === 'number') {
      next.id = sampleRows.reduce((max, item) => Math.max(max, Number(item?.id) || 0), 0) + 1;
    } else {
      next.id = crypto.randomUUID();
    }
  }
  if (next.created_at == null && Object.prototype.hasOwnProperty.call(sample, 'created_at')) next.created_at = now;
  if (next.updated_at == null && Object.prototype.hasOwnProperty.call(sample, 'updated_at')) next.updated_at = now;
  return next;
}

function rowKey(row) {
  return String(row?.[ROW_KEY] ?? row?.id ?? crypto.randomUUID());
}

async function loadRows(client, table) {
  const result = await client.query({
    text: `
      with latest_changes as (
        select distinct on (row_key) row_key, operation, payload
        from public.ourhome_failover_changes
        where table_name = $1 and applied_to_supabase_at is null
        order by row_key, id desc
      ), base as (
        select row_key, payload from public.ourhome_backup_rows where table_name = $1
      ), combined as (
        select coalesce(c.row_key, b.row_key) row_key,
               coalesce(c.operation, 'snapshot') operation,
               coalesce(c.payload, b.payload) payload
        from base b full join latest_changes c using (row_key)
      )
      select row_key, payload from combined where operation <> 'delete'
    `,
    values: [table],
  });
  return result.rows.map(item => {
    const payload = item.payload;
    if (payload && typeof payload === 'object') {
      Object.defineProperty(payload, ROW_KEY, { value: String(item.row_key), enumerable: false });
    }
    return payload;
  });
}

async function recordChange(client, table, operation, row, key = null) {
  const resolvedKey = key || rowKey(row);
  await client.query({
    text: `insert into public.ourhome_failover_changes(table_name,row_key,operation,payload)
           values ($1,$2,$3,$4::jsonb)`,
    values: [table, resolvedKey, operation, operation === 'delete' ? null : JSON.stringify(row)],
  });
  return resolvedKey;
}

async function withFailoverClient(work) {
  if (!pool) throw new Error('Neon 备用存储尚未启用');
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

function failoverObjectSignature(objectKey) {
  if (!secretWrapKey) return '';
  return crypto.createHmac('sha256', secretWrapKey)
    .update(`ourhome-failover-object:${String(objectKey || '')}`)
    .digest('base64url')
    .slice(0, 36);
}

function verifyFailoverObjectSignature(objectKey, signature) {
  const expected = failoverObjectSignature(objectKey);
  const actual = String(signature || '');
  if (!expected || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

async function storeFailoverObjectWithClient(client, {
  objectKey,
  bucket = 'uploads',
  contentType = 'application/octet-stream',
  originalName = '',
  body,
}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
  if (!objectKey || bytes.length === 0) throw new Error('备用文件内容为空');
  if (bytes.length > MAX_FAILOVER_OBJECT_BYTES) throw new Error('备用文件超过 12MB 限制');
  const usage = await client.query({
    text: `select coalesce(sum(size_bytes), 0)::bigint as total
           from public.ourhome_failover_objects
           where uploaded_to_supabase_at is null`,
  });
  const currentBytes = Number(usage.rows[0]?.total || 0);
  if (currentBytes + bytes.length > MAX_FAILOVER_OBJECT_TOTAL_BYTES) {
    throw new Error('Neon 照片暂存区已接近上限，请先等待主存储恢复');
  }
  await client.query({
    text: `insert into public.ourhome_failover_objects
             (object_key,bucket,content_type,original_name,size_bytes,file_data,created_at,updated_at)
           values ($1,$2,$3,$4,$5,$6,now(),now())
           on conflict (object_key) do update
             set bucket=excluded.bucket,
                 content_type=excluded.content_type,
                 original_name=excluded.original_name,
                 size_bytes=excluded.size_bytes,
                 file_data=excluded.file_data,
                 updated_at=now(),
                 upload_error=null`,
    values: [String(objectKey), String(bucket), String(contentType), String(originalName), bytes.length, bytes],
  });
  return { objectKey: String(objectKey), size: bytes.length, signature: failoverObjectSignature(objectKey) };
}

async function storeFailoverObject(input) {
  return withFailoverClient(client => storeFailoverObjectWithClient(client, input));
}

async function readFailoverObject(objectKey) {
  return withFailoverClient(async client => {
    const result = await client.query({
      text: `select object_key,bucket,content_type,original_name,size_bytes,file_data,created_at
             from public.ourhome_failover_objects where object_key=$1 limit 1`,
      values: [String(objectKey)],
    });
    return result.rows[0] || null;
  });
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body == null ? '' : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-OurHome-Data-Source': 'neon-failover',
      ...extraHeaders,
    },
  });
}

function postgrestError(message, code = 'OURHOME_NEON_FAILOVER') {
  return jsonResponse({ message, code, details: null, hint: null }, 503);
}

function parseJsonSecret(value) {
  if (value == null || value === '') return null;
  try { return JSON.parse(value); } catch { return value; }
}

async function decryptedSecret(client, { secretId = null, name = null } = {}) {
  const pending = await client.query({
    text: `
      select operation,
             case when operation = 'upsert' then pgp_sym_decrypt(ciphertext, $3) end as secret
      from public.ourhome_failover_secret_changes
      where ($1::text is not null and secret_id = $1)
         or ($2::text is not null and secret_name = $2)
      order by updated_at desc
      limit 1
    `,
    values: [secretId, name, secretWrapKey],
  });
  if (pending.rows[0]) {
    return pending.rows[0].operation === 'delete' ? null : pending.rows[0].secret;
  }
  const result = await client.query({
    text: `
      select pgp_sym_decrypt(ciphertext, $3) as secret
      from public.ourhome_failover_secrets
      where ($1::text is not null and secret_id = $1)
         or ($2::text is not null and secret_name = $2)
      order by source_updated_at desc nulls last, backed_up_at desc
      limit 1
    `,
    values: [secretId, name, secretWrapKey],
  });
  return result.rows[0]?.secret ?? null;
}

async function storeFailoverSecret(client, { secretId, secretName, secret }) {
  await client.query({
    text: `insert into public.ourhome_failover_secret_changes
             (secret_id,secret_name,operation,ciphertext,created_at,updated_at)
           values ($1,$2,'upsert',pgp_sym_encrypt($3,$4,'cipher-algo=aes256'),now(),now())
           on conflict (secret_id) do update
             set secret_name=excluded.secret_name,
                 operation='upsert',
                 ciphertext=excluded.ciphertext,
                 updated_at=now(),
                 applied_to_supabase_at=null`,
    values: [String(secretId), String(secretName), String(secret), secretWrapKey],
  });
}

async function deleteFailoverSecret(client, { secretId, secretName }) {
  if (!secretId) return;
  await client.query({
    text: `insert into public.ourhome_failover_secret_changes
             (secret_id,secret_name,operation,ciphertext,created_at,updated_at)
           values ($1,$2,'delete',null,now(),now())
           on conflict (secret_id) do update
             set secret_name=excluded.secret_name,
                 operation='delete',
                 ciphertext=null,
                 updated_at=now(),
                 applied_to_supabase_at=null`,
    values: [String(secretId), String(secretName || `ourhome_secret_${secretId}`)],
  });
}

async function journalSettingsForProfile(client, profile, now, settingsRows = null) {
  const settings = settingsRows || await loadRows(client, 'settings');
  const current = settings.find(row => row?.session_id === 'global');
  if (!current) return;
  await recordChange(client, 'settings', 'upsert', {
    ...current,
    api_key: null,
    api_base_url: profile.base_url,
    selected_model: profile.selected_model || current.selected_model || null,
    updated_at: now,
  }, rowKey(current));
}

async function activateApiProfile(client, profileId) {
  const [profiles, settings] = await Promise.all([
    loadRows(client, 'api_profiles'),
    loadRows(client, 'settings'),
  ]);
  const target = profiles.find(profile => String(profile?.id) === String(profileId || ''));
  if (!target) return postgrestError('找不到这个 API 站点', 'P0002');

  const now = new Date().toISOString();
  const activated = { ...target, is_active: true, updated_at: now };

  await client.query('begin');
  try {
    for (const profile of profiles) {
      if (!profile?.is_active || String(profile.id) === String(target.id)) continue;
      await recordChange(client, 'api_profiles', 'upsert', {
        ...profile,
        is_active: false,
        updated_at: now,
      }, rowKey(profile));
    }
    await recordChange(client, 'api_profiles', 'upsert', activated, rowKey(target));
    await journalSettingsForProfile(client, activated, now, settings);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  return jsonResponse(activated);
}

async function saveApiProfile(client, body = {}) {
  const [profiles, settings] = await Promise.all([
    loadRows(client, 'api_profiles'),
    loadRows(client, 'settings'),
  ]);
  const id = String(body.p_id || crypto.randomUUID());
  const name = String(body.p_name || '').trim();
  const baseUrl = String(body.p_base_url || '').trim().replace(/\/+$/, '');
  if (!name || !baseUrl) return postgrestError('站点名称和 API 网址不能为空', '22023');
  const existing = profiles.find(profile => String(profile?.id) === id) || null;
  const makeActive = Boolean(body.p_make_active);
  const now = new Date().toISOString();
  let secretId = existing?.api_key_secret_id || null;
  const apiKey = String(body.p_api_key || '').trim();
  if (apiKey && !secretId) secretId = crypto.randomUUID();
  const shouldBeActive = makeActive || existing?.is_active || !profiles.some(profile => profile?.is_active);
  const profile = {
    ...(existing || {}),
    id,
    name,
    base_url: baseUrl,
    api_key_secret_id: secretId,
    selected_model: String(body.p_selected_model || '').trim() || null,
    is_active: Boolean(shouldBeActive),
    created_at: existing?.created_at || now,
    updated_at: now,
  };

  await client.query('begin');
  try {
    if (apiKey) {
      await storeFailoverSecret(client, {
        secretId,
        secretName: `ourhome_api_${id}`,
        secret: apiKey,
      });
    }
    if (profile.is_active) {
      for (const current of profiles) {
        if (!current?.is_active || String(current.id) === id) continue;
        await recordChange(client, 'api_profiles', 'upsert', {
          ...current,
          is_active: false,
          updated_at: now,
        }, rowKey(current));
      }
    }
    await recordChange(client, 'api_profiles', 'upsert', profile, existing ? rowKey(existing) : id);
    if (profile.is_active) await journalSettingsForProfile(client, profile, now, settings);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  return jsonResponse(profile);
}

async function deleteApiProfile(client, profileId) {
  const [profiles, settings] = await Promise.all([
    loadRows(client, 'api_profiles'),
    loadRows(client, 'settings'),
  ]);
  const target = profiles.find(profile => String(profile?.id) === String(profileId || ''));
  if (!target) return jsonResponse(null);
  const remaining = profiles.filter(profile => String(profile?.id) !== String(target.id));
  const next = target.is_active
    ? [...remaining].sort((left, right) => Date.parse(right?.updated_at || 0) - Date.parse(left?.updated_at || 0))[0]
    : null;
  const now = new Date().toISOString();

  await client.query('begin');
  try {
    await recordChange(client, 'api_profiles', 'delete', null, rowKey(target));
    await deleteFailoverSecret(client, {
      secretId: target.api_key_secret_id,
      secretName: `ourhome_api_${target.id}`,
    });
    if (next) {
      const activated = { ...next, is_active: true, updated_at: now };
      await recordChange(client, 'api_profiles', 'upsert', activated, rowKey(next));
      await journalSettingsForProfile(client, activated, now, settings);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  return jsonResponse(null);
}

async function saveServiceConnection(client, body = {}) {
  const connections = await loadRows(client, 'service_connections');
  const id = String(body.p_id || crypto.randomUUID());
  const existing = connections.find(connection => String(connection?.id) === id) || null;
  const kind = String(body.p_kind || '');
  const name = String(body.p_name || '').trim();
  const url = String(body.p_url || '').trim();
  if (!['web_search', 'mcp', 'agentmail'].includes(kind) || !name || !url) {
    return postgrestError('联网服务的类型、名称或网址不正确', '22023');
  }
  const secret = String(body.p_secret || '').trim();
  let secretId = existing?.secret_id || null;
  if (secret && !secretId) secretId = crypto.randomUUID();
  const now = new Date().toISOString();
  const connection = {
    ...(existing || {}),
    id,
    kind,
    name,
    url,
    secret_id: secretId,
    enabled: body.p_enabled !== false,
    config: body.p_config && typeof body.p_config === 'object' ? body.p_config : {},
    created_at: existing?.created_at || now,
    updated_at: now,
  };

  await client.query('begin');
  try {
    if (secret) {
      await storeFailoverSecret(client, {
        secretId,
        secretName: `ourhome_connection_${id}`,
        secret,
      });
    }
    await recordChange(client, 'service_connections', 'upsert', connection, existing ? rowKey(existing) : id);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  return jsonResponse(connection);
}

async function deleteServiceConnection(client, connectionId) {
  const connections = await loadRows(client, 'service_connections');
  const target = connections.find(connection => String(connection?.id) === String(connectionId || ''));
  if (!target) return jsonResponse(null);
  await client.query('begin');
  try {
    await recordChange(client, 'service_connections', 'delete', null, rowKey(target));
    await deleteFailoverSecret(client, { secretId: target.secret_id, secretName: `ourhome_connection_${target.id}` });
    await deleteFailoverSecret(client, { secretId: target.webhook_secret_id, secretName: `ourhome_agentmail_webhook_${target.id}` });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  return jsonResponse(null);
}

async function saveAgentMailWebhookSecret(client, body = {}) {
  const connections = await loadRows(client, 'service_connections');
  const target = connections.find(connection => (
    String(connection?.id) === String(body.p_connection_id || '') && connection?.kind === 'agentmail'
  ));
  if (!target) return postgrestError('找不到 AgentMail 连接', 'P0002');
  const secret = String(body.p_secret || '').trim();
  const secretId = target.webhook_secret_id || (secret ? crypto.randomUUID() : null);
  const now = new Date().toISOString();
  let config = target.config && typeof target.config === 'object' ? { ...target.config } : {};
  if (!secret) {
    delete config.webhook_id;
    delete config.webhook_url;
    delete config.webhook_registered_at;
  }
  const connection = { ...target, webhook_secret_id: secret ? secretId : null, config, updated_at: now };

  await client.query('begin');
  try {
    if (secret) {
      await storeFailoverSecret(client, {
        secretId,
        secretName: `ourhome_agentmail_webhook_${target.id}`,
        secret,
      });
    } else {
      await deleteFailoverSecret(client, {
        secretId: target.webhook_secret_id,
        secretName: `ourhome_agentmail_webhook_${target.id}`,
      });
    }
    await recordChange(client, 'service_connections', 'upsert', connection, rowKey(target));
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  return jsonResponse(secretId);
}

function vaultBalanceDelta(account, type, amount, reverse = false) {
  let delta;
  const debt = Boolean(account?.is_debt) || account?.type === 'debt';
  if (debt) delta = type === 'expense' ? amount : -amount;
  else delta = type === 'income' ? amount : -amount;
  return reverse ? -delta : delta;
}

async function touchVaultSyncState(client, now) {
  const rows = await loadRows(client, 'vault_sync_state');
  const current = rows.find(row => row?.id === 'global') || { id: 'global' };
  await recordChange(client, 'vault_sync_state', 'upsert', {
    ...current,
    initialized: true,
    updated_at: now,
  }, rowKey(current));
}

async function createVaultTransaction(client, body = {}) {
  const [accounts, groups, categories, transactions, history] = await Promise.all([
    loadRows(client, 'vault_accounts'),
    loadRows(client, 'vault_account_groups'),
    loadRows(client, 'vault_categories'),
    loadRows(client, 'vault_transactions'),
    loadRows(client, 'vault_account_history'),
  ]);
  const account = accounts.find(row => String(row?.id) === String(body.p_account_id || ''));
  const type = body.p_type === 'income' || body.p_type === 'expense' ? body.p_type : '';
  const amount = Number(body.p_amount);
  if (!account) return postgrestError('找不到指定账户', 'P0002');
  if (!type || !Number.isFinite(amount) || amount <= 0) return postgrestError('收支类型或金额不正确', '22023');

  const now = new Date().toISOString();
  const group = groups.find(row => String(row?.id) === String(account.group_id || ''));
  const categoryName = String(body.p_category_name || '').trim().slice(0, 80) || '其他';
  const category = categories.find(row => row?.type === type && row?.name === categoryName) || null;
  const delta = vaultBalanceDelta(account, type, amount);
  const nextAccount = { ...account, balance: Number(account.balance || 0) + delta, updated_at: now };
  const transaction = inferDefaults({
    date: String(body.p_date || now.slice(0, 10)),
    type,
    amount,
    category_id: category?.id || null,
    category_name: categoryName,
    account_id: account.id,
    account_name_snapshot: account.name || null,
    group_name_snapshot: group?.name || null,
    tag: String(body.p_tag || '').slice(0, 40),
    note: String(body.p_note || '').slice(0, 500),
    source: String(body.p_source || 'manual').slice(0, 40) || 'manual',
    created_at: now,
  }, transactions);
  const historyRow = inferDefaults({
    account_id: account.id,
    balance: nextAccount.balance,
    change: delta,
    reason: 'transaction',
    created_at: now,
  }, history);

  await client.query('begin');
  try {
    await recordChange(client, 'vault_accounts', 'upsert', nextAccount, rowKey(account));
    await recordChange(client, 'vault_account_history', 'upsert', historyRow);
    await recordChange(client, 'vault_transactions', 'upsert', transaction);
    await touchVaultSyncState(client, now);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  return jsonResponse(transaction.id);
}

async function deleteVaultTransaction(client, body = {}) {
  const [transactions, accounts, history] = await Promise.all([
    loadRows(client, 'vault_transactions'),
    loadRows(client, 'vault_accounts'),
    loadRows(client, 'vault_account_history'),
  ]);
  const transaction = transactions.find(row => String(row?.id) === String(body.p_transaction_id || ''));
  if (!transaction) return jsonResponse(false);
  const account = accounts.find(row => String(row?.id) === String(transaction.account_id || '')) || null;
  const now = new Date().toISOString();

  await client.query('begin');
  try {
    if (account) {
      const delta = vaultBalanceDelta(account, transaction.type, Number(transaction.amount || 0), true);
      const nextAccount = { ...account, balance: Number(account.balance || 0) + delta, updated_at: now };
      const historyRow = inferDefaults({
        account_id: account.id,
        balance: nextAccount.balance,
        change: delta,
        reason: 'delete_transaction',
        created_at: now,
      }, history);
      await recordChange(client, 'vault_accounts', 'upsert', nextAccount, rowKey(account));
      await recordChange(client, 'vault_account_history', 'upsert', historyRow);
    }
    await recordChange(client, 'vault_transactions', 'delete', null, rowKey(transaction));
    await touchVaultSyncState(client, now);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  return jsonResponse(true);
}

async function handleRpcRequest(client, rpcName, body) {
  if (rpcName === 'ourhome_get_api_profile_secret') {
    const profiles = await loadRows(client, 'api_profiles');
    const profile = profiles.find(row => String(row?.id) === String(body?.p_profile_id || ''));
    return jsonResponse(profile?.api_key_secret_id
      ? await decryptedSecret(client, { secretId: String(profile.api_key_secret_id) })
      : null);
  }

  if (rpcName === 'ourhome_get_service_secret' || rpcName === 'ourhome_get_agentmail_webhook_secret') {
    const connections = await loadRows(client, 'service_connections');
    const connection = connections.find(row => String(row?.id) === String(body?.p_connection_id || ''));
    const key = rpcName === 'ourhome_get_agentmail_webhook_secret' ? 'webhook_secret_id' : 'secret_id';
    return jsonResponse(connection?.[key]
      ? await decryptedSecret(client, { secretId: String(connection[key]) })
      : null);
  }

  if (rpcName === 'ourhome_get_daily_automation_token') {
    return jsonResponse(await decryptedSecret(client, { name: 'ourhome_daily_automation_token' }));
  }

  if (rpcName === 'ourhome_get_or_create_vapid_keys') {
    const existing = await decryptedSecret(client, { name: 'ourhome_vapid_keys' });
    return jsonResponse(parseJsonSecret(existing) || parseJsonSecret(body?.p_secret));
  }

  if (rpcName === 'ourhome_activate_api_profile') {
    return activateApiProfile(client, body?.p_id);
  }

  if (rpcName === 'ourhome_save_api_profile') {
    return saveApiProfile(client, body);
  }

  if (rpcName === 'ourhome_delete_api_profile') {
    return deleteApiProfile(client, body?.p_id);
  }

  if (rpcName === 'ourhome_save_service_connection') {
    return saveServiceConnection(client, body);
  }

  if (rpcName === 'ourhome_delete_service_connection') {
    return deleteServiceConnection(client, body?.p_connection_id);
  }

  if (rpcName === 'ourhome_save_agentmail_webhook_secret') {
    return saveAgentMailWebhookSecret(client, body);
  }

  if (rpcName === 'ourhome_vault_create_transaction') {
    return createVaultTransaction(client, body);
  }

  if (rpcName === 'ourhome_vault_delete_transaction') {
    return deleteVaultTransaction(client, body);
  }

  return postgrestError(`Supabase RPC ${rpcName} is unavailable while the emergency database is active.`);
}

function wantsObject(headers) {
  return /vnd\.pgrst\.object\+json/i.test(headers.get('accept') || '');
}

function formatReadResponse(rows, headers, total, offset = 0) {
  if (wantsObject(headers)) {
    if (rows.length === 1) return jsonResponse(rows[0]);
    return jsonResponse({
      message: `JSON object requested, multiple (or no) rows returned`,
      code: 'PGRST116', details: `The result contains ${rows.length} rows`, hint: null,
    }, 406);
  }
  const end = rows.length ? offset + rows.length - 1 : offset;
  return jsonResponse(rows, 200, { 'Content-Range': `${offset}-${end}/${total}` });
}

function readWindow(params, headers) {
  const range = String(headers.get('range') || '').match(/^(\d+)-(\d+)$/);
  const offsetParam = params.get('offset');
  const limitParam = params.get('limit');
  const offset = Math.max(0, Number(offsetParam == null || offsetParam === '' ? range?.[1] : offsetParam) || 0);
  const queryLimit = limitParam == null || limitParam === '' ? NaN : Number(limitParam);
  const rangeLimit = range ? Number(range[2]) - Number(range[1]) + 1 : NaN;
  const limit = Number.isFinite(queryLimit)
    ? queryLimit
    : (Number.isFinite(rangeLimit) ? rangeLimit : null);
  return { offset, limit };
}

async function handleTableRequest(client, url, method, headers, body) {
  const table = decodeURIComponent(url.pathname.split('/rest/v1/')[1] || '').replace(/^\/+|\/+$/g, '');
  if (table.startsWith('rpc/')) {
    return handleRpcRequest(client, table.slice(4), body || {});
  }
  if (!/^[a-zA-Z_][\w]*$/.test(table)) {
    return postgrestError('This Supabase request is unavailable while the emergency database is active.');
  }
  const allRows = await loadRows(client, table);
  const matched = applyFilters(allRows, url.searchParams);
  const prefer = headers.get('prefer') || '';

  if (method === 'GET' || method === 'HEAD') {
    const ordered = applyOrder(matched, url.searchParams.get('order'));
    const { offset, limit } = readWindow(url.searchParams, headers);
    const limited = Number.isFinite(limit) && limit >= 0 ? ordered.slice(offset, offset + limit) : ordered.slice(offset);
    const projected = projectRows(limited, url.searchParams.get('select'));
    if (method === 'HEAD') return jsonResponse(null, 200, { 'Content-Range': `0-0/${matched.length}` });
    return formatReadResponse(projected, headers, matched.length, offset);
  }

  if (method === 'POST') {
    const incoming = Array.isArray(body) ? body : [body || {}];
    const onConflict = String(url.searchParams.get('on_conflict') || 'id').split(',').filter(Boolean);
    const merge = /resolution=merge-duplicates/i.test(prefer);
    const saved = [];
    for (const raw of incoming) {
      let next = inferDefaults(raw, [...allRows, ...saved]);
      let changeKey = null;
      if (merge) {
        const existing = allRows.find(row => onConflict.every(column => comparable(row?.[column]) === comparable(next?.[column])));
        if (existing) {
          changeKey = rowKey(existing);
          next = { ...existing, ...next, updated_at: next.updated_at || new Date().toISOString() };
        }
      }
      await recordChange(client, table, 'upsert', next, changeKey);
      saved.push(next);
    }
    const result = projectRows(saved, url.searchParams.get('select'));
    if (/return=minimal/i.test(prefer)) return jsonResponse(null, 201);
    return wantsObject(headers) ? jsonResponse(result[0] || null, 201) : jsonResponse(result, 201);
  }

  if (method === 'PATCH') {
    const updated = [];
    for (const current of matched) {
      const next = { ...current, ...(body || {}) };
      if (Object.prototype.hasOwnProperty.call(current, 'updated_at') && !Object.prototype.hasOwnProperty.call(body || {}, 'updated_at')) {
        next.updated_at = new Date().toISOString();
      }
      await recordChange(client, table, 'upsert', next, rowKey(current));
      updated.push(next);
    }
    if (/return=minimal/i.test(prefer)) return jsonResponse(null);
    return formatReadResponse(projectRows(updated, url.searchParams.get('select')), headers, updated.length);
  }

  if (method === 'DELETE') {
    for (const current of matched) await recordChange(client, table, 'delete', null, rowKey(current));
    if (/return=minimal/i.test(prefer)) return jsonResponse(null);
    return formatReadResponse(projectRows(matched, url.searchParams.get('select')), headers, matched.length);
  }

  return postgrestError(`Unsupported emergency database method: ${method}`);
}

async function neonFallback(input, init = {}) {
  if (!pool) return null;
  const url = new URL(requestUrl(input));
  const method = requestMethod(input, init);
  const headers = requestHeaders(input, init);
  const body = await requestJson(input, init);
  const client = await pool.connect();
  try {
    return await handleTableRequest(client, url, method, headers, body);
  } finally {
    client.release();
  }
}

if (typeof upstreamFetch === 'function' && pool) {
  globalThis.fetch = async function ourHomeNeonFailoverFetch(input, init = {}) {
    const response = await upstreamFetch(input, init);
    if (response.status !== 402 || !isSupabaseRestUrl(requestUrl(input))) return response;
    try {
      const fallback = await neonFallback(input, init);
      if (fallback) {
        console.warn(`[neon-failover] ${requestMethod(input, init)} ${new URL(requestUrl(input)).pathname}`);
        return fallback;
      }
    } catch (error) {
      console.error('[neon-failover] request failed:', String(error?.message || error).slice(0, 300));
    }
    return response;
  };
  console.warn('[neon-failover] armed; Supabase remains primary and Neon handles REST status 402 only');
} else if (enabled) {
  console.warn('[neon-failover] enabled but OURHOME_NEON_DATABASE_URL is missing');
}

module.exports = {
  activateApiProfile,
  applyFilters,
  applyOrder,
  createVaultTransaction,
  deleteVaultTransaction,
  deleteApiProfile,
  deleteServiceConnection,
  decryptedSecret,
  failoverObjectSignature,
  handleRpcRequest,
  inferDefaults,
  matchFilter,
  projectRows,
  readFailoverObject,
  readWindow,
  saveAgentMailWebhookSecret,
  saveApiProfile,
  saveServiceConnection,
  storeFailoverObject,
  storeFailoverObjectWithClient,
  verifyFailoverObjectSignature,
};
