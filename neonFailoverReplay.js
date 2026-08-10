'use strict';

const { Pool } = require('pg');

const SAFE_NAME = /^[a-zA-Z_][\w]*$/;
const FAILOVER_FILE_PATH = '/failover-files/';

function primaryHeaders(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function conflictColumn(change) {
  const payload = change?.payload || {};
  if (change?.operation === 'delete') return 'id';
  if (payload.id != null) return 'id';
  if (payload.session_id != null) return 'session_id';
  throw new Error(`${change?.table_name || 'unknown'}:${change?.row_key || 'unknown'} 没有可安全回迁的主键`);
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function primaryRowIsNewer(primary, change) {
  const primaryAt = timestamp(primary?.updated_at || primary?.created_at);
  const pendingAt = timestamp(change?.payload?.updated_at || change?.changed_at);
  return primaryAt != null && pendingAt != null && primaryAt > pendingAt;
}

async function responseError(response) {
  const text = await response.text().catch(() => '');
  return `Supabase HTTP ${response.status}${text ? `: ${text.slice(0, 240)}` : ''}`;
}

function encodeObjectPath(value) {
  return String(value || '').split('/').map(part => encodeURIComponent(part)).join('/');
}

function failoverObjectKeyFromUrl(value) {
  if (typeof value !== 'string' || !value.includes(FAILOVER_FILE_PATH)) return '';
  try {
    const parsed = new URL(value);
    const index = parsed.pathname.indexOf(FAILOVER_FILE_PATH);
    if (index < 0) return '';
    return decodeURIComponent(parsed.pathname.slice(index + FAILOVER_FILE_PATH.length));
  } catch {
    return '';
  }
}

function rewriteFailoverObjectUrls(value, publicUrls) {
  if (typeof value === 'string') {
    const key = failoverObjectKeyFromUrl(value);
    return key && publicUrls.has(key) ? publicUrls.get(key) : value;
  }
  if (Array.isArray(value)) return value.map(item => rewriteFailoverObjectUrls(item, publicUrls));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteFailoverObjectUrls(item, publicUrls)]));
  }
  return value;
}

function unresolvedFailoverObjectKey(value, publicUrls) {
  if (typeof value === 'string') {
    const key = failoverObjectKeyFromUrl(value);
    return key && !publicUrls.has(key) ? key : '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = unresolvedFailoverObjectKey(item, publicUrls);
      if (found) return found;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = unresolvedFailoverObjectKey(item, publicUrls);
      if (found) return found;
    }
  }
  return '';
}

function createNeonFailoverReplay({
  databaseUrl = process.env.OURHOME_NEON_DATABASE_URL,
  supabaseUrl = process.env.SUPABASE_URL,
  supabaseKey = process.env.SUPABASE_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!databaseUrl || !supabaseUrl || !supabaseKey || typeof fetchImpl !== 'function') return null;
  const pool = new Pool({ connectionString: databaseUrl, max: 2, ssl: { rejectUnauthorized: false } });
  const base = String(supabaseUrl).replace(/\/+$/, '');

  async function pendingSummary(client) {
    const result = await client.query(`
      select table_name, count(*)::integer pending_changes,
             count(distinct row_key)::integer pending_rows,
             min(changed_at) first_change, max(changed_at) last_change
      from public.ourhome_failover_changes
      where applied_to_supabase_at is null
      group by table_name order by table_name
    `);
    const secrets = await client.query(`
      select count(*)::integer pending_secrets
      from public.ourhome_failover_secret_changes
      where applied_to_supabase_at is null
    `).catch(() => ({ rows: [{ pending_secrets: 0 }] }));
    const objects = await client.query(`
      select count(*)::integer pending_objects,
             coalesce(sum(size_bytes), 0)::bigint pending_object_bytes
      from public.ourhome_failover_objects
      where uploaded_to_supabase_at is null
    `).catch(() => ({ rows: [{ pending_objects: 0, pending_object_bytes: 0 }] }));
    return {
      tables: result.rows,
      pending_secrets: Number(secrets.rows[0]?.pending_secrets || 0),
      pending_objects: Number(objects.rows[0]?.pending_objects || 0),
      pending_object_bytes: Number(objects.rows[0]?.pending_object_bytes || 0),
    };
  }

  async function probePrimary() {
    try {
      const response = await fetchImpl(`${base}/rest/v1/settings?select=id&limit=1`, {
        headers: primaryHeaders(supabaseKey),
      });
      if (!response.ok) return { ready: false, status: response.status, error: await responseError(response) };
      return { ready: true, status: response.status, error: '' };
    } catch (error) {
      return { ready: false, status: 0, error: String(error?.message || error).slice(0, 240) };
    }
  }

  async function status() {
    const [primary, client] = await Promise.all([probePrimary(), pool.connect()]);
    try {
      return {
        ...(await pendingSummary(client)),
        primary_ready: primary.ready,
        primary_status: primary.status,
      };
    } finally {
      client.release();
    }
  }

  async function assertPrimaryReady() {
    const primary = await probePrimary();
    if (!primary.ready) {
      const error = new Error(primary.error || `Supabase REST 还没有恢复（${primary.status || '网络不可达'}）`);
      error.code = 'primary_not_ready';
      throw error;
    }
  }

  function publicObjectUrl(bucket, objectKey) {
    return `${base}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodeObjectPath(objectKey)}`;
  }

  async function loadPublicObjectUrls(client) {
    const result = await client.query(`
      select object_key,bucket from public.ourhome_failover_objects
      where uploaded_to_supabase_at is not null
    `);
    return new Map(result.rows.map(row => [String(row.object_key), publicObjectUrl(row.bucket, row.object_key)]));
  }

  async function uploadPendingObjects(client, { limit = 100 } = {}) {
    const result = await client.query({
      text: `select object_key,bucket,content_type,size_bytes,file_data
             from public.ourhome_failover_objects
             where uploaded_to_supabase_at is null
             order by created_at asc
             limit $1`,
      values: [Math.min(250, Math.max(1, Number(limit) || 100))],
    });
    const uploaded = [];
    for (const object of result.rows) {
      try {
        const response = await fetchImpl(
          `${base}/storage/v1/object/${encodeURIComponent(object.bucket)}/${encodeObjectPath(object.object_key)}`,
          {
            method: 'POST',
            headers: primaryHeaders(supabaseKey, {
              'Content-Type': object.content_type || 'application/octet-stream',
              'x-upsert': 'true',
            }),
            body: object.file_data,
          },
        );
        if (!response.ok) throw new Error(await responseError(response));
        await client.query({
          text: `update public.ourhome_failover_objects
                 set uploaded_to_supabase_at=now(), upload_error=null, updated_at=now()
                 where object_key=$1`,
          values: [object.object_key],
        });
        uploaded.push({ object_key: object.object_key, size_bytes: Number(object.size_bytes || 0) });
      } catch (error) {
        const message = String(error?.message || error).slice(0, 300);
        await client.query({
          text: `update public.ourhome_failover_objects set upload_error=$2, updated_at=now() where object_key=$1`,
          values: [object.object_key, message],
        });
        const wrapped = new Error(`备用文件 ${object.object_key} 回迁失败：${message}`);
        wrapped.code = 'object_replay_failed';
        throw wrapped;
      }
    }
    return uploaded;
  }

  async function applyChange(change, publicUrls) {
    if (!SAFE_NAME.test(change.table_name)) throw new Error('回迁表名不安全');
    const unresolvedObjectKey = unresolvedFailoverObjectKey(change.payload, publicUrls);
    if (unresolvedObjectKey) {
      throw new Error(`备用文件 ${unresolvedObjectKey} 尚未安全回到 Supabase，已暂停关联数据回迁`);
    }
    const nextChange = {
      ...change,
      payload: rewriteFailoverObjectUrls(change.payload, publicUrls),
    };
    const key = conflictColumn(nextChange);
    const encodedTable = encodeURIComponent(nextChange.table_name);
    const encodedKey = encodeURIComponent(key);
    const value = encodeURIComponent(nextChange.row_key);
    const currentResponse = await fetchImpl(
      `${base}/rest/v1/${encodedTable}?select=*&${encodedKey}=eq.${value}&limit=1`,
      { headers: primaryHeaders(supabaseKey) },
    );
    if (!currentResponse.ok) throw new Error(await responseError(currentResponse));
    const currentRows = await currentResponse.json().catch(() => []);
    if (primaryRowIsNewer(currentRows?.[0], nextChange)) {
      const error = new Error('Supabase 中的同一条数据更新得更晚，已保留 Neon 原件并暂停自动回迁');
      error.code = 'primary_row_newer';
      throw error;
    }
    let response;
    if (nextChange.operation === 'delete') {
      response = await fetchImpl(`${base}/rest/v1/${encodedTable}?${encodedKey}=eq.${value}`, {
        method: 'DELETE',
        headers: primaryHeaders(supabaseKey, { Prefer: 'return=minimal' }),
      });
    } else {
      response = await fetchImpl(`${base}/rest/v1/${encodedTable}?on_conflict=${encodedKey}`, {
        method: 'POST',
        headers: primaryHeaders(supabaseKey, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(nextChange.payload || {}),
      });
    }
    if (!response.ok) throw new Error(await responseError(response));
  }

  async function replay({ limit = 250 } = {}) {
    await assertPrimaryReady();
    const client = await pool.connect();
    try {
      const summary = await pendingSummary(client);
      if (summary.pending_secrets > 0) {
        const error = new Error('还有加密密钥等待专用回迁，已暂停普通数据回迁以避免配置错配');
        error.code = 'pending_secret_replay';
        throw error;
      }

      const uploadedObjects = await uploadPendingObjects(client, { limit: Math.min(250, Math.max(25, Number(limit) || 250)) });
      const publicUrls = await loadPublicObjectUrls(client);
      const result = await client.query({
        text: `
          select distinct on (table_name,row_key)
                 table_name,row_key,operation,payload,id,changed_at
          from public.ourhome_failover_changes
          where applied_to_supabase_at is null
          order by table_name,row_key,id desc
          limit $1
        `,
        values: [Math.min(1000, Math.max(1, Number(limit) || 250))],
      });
      const applied = [];
      const failed = [];
      for (const change of result.rows) {
        try {
          await applyChange(change, publicUrls);
          await client.query({
            text: `update public.ourhome_failover_changes
                   set applied_to_supabase_at=now(), apply_error=null
                   where table_name=$1 and row_key=$2 and applied_to_supabase_at is null`,
            values: [change.table_name, change.row_key],
          });
          applied.push({ table_name: change.table_name, row_key: change.row_key });
        } catch (error) {
          const message = String(error?.message || error).slice(0, 300);
          await client.query({
            text: `update public.ourhome_failover_changes set apply_error=$3
                   where table_name=$1 and row_key=$2 and applied_to_supabase_at is null`,
            values: [change.table_name, change.row_key, message],
          });
          failed.push({ table_name: change.table_name, row_key: change.row_key, error: message });
          break;
        }
      }
      return { applied, failed, uploaded_objects: uploadedObjects, remaining: await pendingSummary(client) };
    } finally {
      client.release();
    }
  }

  return { status, replay };
}

module.exports = {
  conflictColumn,
  createNeonFailoverReplay,
  failoverObjectKeyFromUrl,
  primaryRowIsNewer,
  rewriteFailoverObjectUrls,
};
