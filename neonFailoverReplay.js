'use strict';

const { Pool } = require('pg');

const SAFE_NAME = /^[a-zA-Z_][\w]*$/;

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
    return { tables: result.rows, pending_secrets: Number(secrets.rows[0]?.pending_secrets || 0) };
  }

  async function status() {
    const client = await pool.connect();
    try { return await pendingSummary(client); }
    finally { client.release(); }
  }

  async function assertPrimaryReady() {
    const response = await fetchImpl(`${base}/rest/v1/settings?select=id&limit=1`, {
      headers: primaryHeaders(supabaseKey),
    });
    if (!response.ok) throw new Error(await responseError(response));
  }

  async function applyChange(change) {
    if (!SAFE_NAME.test(change.table_name)) throw new Error('回迁表名不安全');
    const key = conflictColumn(change);
    const encodedTable = encodeURIComponent(change.table_name);
    const encodedKey = encodeURIComponent(key);
    const value = encodeURIComponent(change.row_key);
    const currentResponse = await fetchImpl(
      `${base}/rest/v1/${encodedTable}?select=*&${encodedKey}=eq.${value}&limit=1`,
      { headers: primaryHeaders(supabaseKey) },
    );
    if (!currentResponse.ok) throw new Error(await responseError(currentResponse));
    const currentRows = await currentResponse.json().catch(() => []);
    if (primaryRowIsNewer(currentRows?.[0], change)) {
      const error = new Error('Supabase 中的同一条数据更新得更晚，已保留 Neon 原件并暂停自动回迁');
      error.code = 'primary_row_newer';
      throw error;
    }
    let response;
    if (change.operation === 'delete') {
      response = await fetchImpl(`${base}/rest/v1/${encodedTable}?${encodedKey}=eq.${value}`, {
        method: 'DELETE',
        headers: primaryHeaders(supabaseKey, { Prefer: 'return=minimal' }),
      });
    } else {
      response = await fetchImpl(`${base}/rest/v1/${encodedTable}?on_conflict=${encodedKey}`, {
        method: 'POST',
        headers: primaryHeaders(supabaseKey, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(change.payload || {}),
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
          await applyChange(change);
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
      return { applied, failed, remaining: await pendingSummary(client) };
    } finally {
      client.release();
    }
  }

  return { status, replay };
}

module.exports = { conflictColumn, createNeonFailoverReplay, primaryRowIsNewer };
