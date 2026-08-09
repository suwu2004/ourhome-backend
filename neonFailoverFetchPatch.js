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
  return String(row?.id ?? crypto.randomUUID());
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
  return result.rows.map(item => item.payload);
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
  const result = await client.query({
    text: `
      select pgp_sym_decrypt(ciphertext, $3) as secret
      from public.ourhome_failover_secrets
      where ($1::text is not null and secret_id = $1)
         or ($2::text is not null and secret_name = $2)
      order by updated_at desc
      limit 1
    `,
    values: [secretId, name, secretWrapKey],
  });
  return result.rows[0]?.secret ?? null;
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
    const range = String(headers.get('range') || '').match(/^(\d+)-(\d+)$/);
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || Number(range?.[1]) || 0);
    const queryLimit = Number(url.searchParams.get('limit'));
    const rangeLimit = range ? Number(range[2]) - Number(range[1]) + 1 : NaN;
    const limitValue = Number.isFinite(queryLimit) ? queryLimit : rangeLimit;
    const limited = Number.isFinite(limitValue) && limitValue >= 0 ? ordered.slice(offset, offset + limitValue) : ordered.slice(offset);
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
      if (merge) {
        const existing = allRows.find(row => onConflict.every(column => comparable(row?.[column]) === comparable(next?.[column])));
        if (existing) next = { ...existing, ...next, updated_at: next.updated_at || new Date().toISOString() };
      }
      await recordChange(client, table, 'upsert', next);
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
  applyFilters,
  applyOrder,
  inferDefaults,
  matchFilter,
  projectRows,
};
