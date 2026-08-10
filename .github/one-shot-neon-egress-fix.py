from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


patch_path = Path('neonFailoverFetchPatch.js')
source = patch_path.read_text()

anchor = "async function recordChange(client, table, operation, row, key = null) {"
helpers = r'''
const SQL_READ_RESERVED_PARAMS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
const SQL_READ_FILTER_OPS = new Set(['eq', 'neq', 'is', 'in', 'like', 'ilike']);
const SQL_READ_ORDER_FIELDS = new Set([
  'created_at', 'updated_at', 'changed_at', 'source_updated_at', 'backed_up_at',
  'remind_at', 'last_run_at', 'claimed_at', 'completed_at', 'retry_after', 'date',
]);

function safeJsonField(value) {
  const field = String(value || '');
  return /^[a-zA-Z_][\w]*$/.test(field) ? field : '';
}

function decodedFilterValue(value) {
  try { return decodeURIComponent(String(value || '')); }
  catch { return String(value || ''); }
}

function sqlJsonEquality(column, expected, values, { negate = false } = {}) {
  const field = safeJsonField(column);
  if (!field) return null;
  if (expected === null || typeof expected === 'number' || typeof expected === 'boolean') {
    values.push(JSON.stringify(expected));
    const operator = negate ? 'is distinct from' : '=';
    return `(payload -> '${field}') ${operator} $${values.length + 1}::jsonb`;
  }
  values.push(String(expected));
  const operator = negate ? 'is distinct from' : '=';
  return `(payload ->> '${field}') ${operator} $${values.length + 1}::text`;
}

function buildSqlReadPlan(params, headers = new Headers()) {
  if (params.has('and') || params.has('or')) return null;
  const values = [];
  const clauses = [];

  for (const [column, expression] of params.entries()) {
    if (SQL_READ_RESERVED_PARAMS.has(column)) continue;
    const field = safeJsonField(column);
    if (!field) return null;
    const dot = String(expression || '').indexOf('.');
    const op = dot < 0 ? 'eq' : expression.slice(0, dot);
    const raw = dot < 0 ? expression : expression.slice(dot + 1);
    if (!SQL_READ_FILTER_OPS.has(op)) return null;

    if (op === 'is') {
      if (raw === 'null') {
        clauses.push(`((payload -> '${field}') is null or (payload -> '${field}') = 'null'::jsonb)`);
        continue;
      }
      if (raw === 'true' || raw === 'false') {
        const clause = sqlJsonEquality(field, raw === 'true', values);
        if (!clause) return null;
        clauses.push(clause);
        continue;
      }
      return null;
    }

    if (op === 'in') {
      const items = parseInList(raw);
      if (!items.length) {
        clauses.push('false');
        continue;
      }
      const alternatives = [];
      for (const item of items) {
        const clause = sqlJsonEquality(field, item, values);
        if (!clause) return null;
        alternatives.push(clause);
      }
      clauses.push(`(${alternatives.join(' or ')})`);
      continue;
    }

    if (op === 'like' || op === 'ilike') {
      const decoded = decodedFilterValue(raw);
      // The legacy matcher only treats % and * as wildcards. SQL LIKE also
      // treats underscore as a wildcard, so preserve correctness by falling back.
      if (decoded.includes('_')) return null;
      values.push(decoded.replace(/\*/g, '%'));
      clauses.push(`coalesce(payload ->> '${field}', '') ${op === 'ilike' ? 'ilike' : 'like'} $${values.length + 1}::text`);
      continue;
    }

    const expected = scalar(decodedFilterValue(raw));
    const clause = sqlJsonEquality(field, expected, values, { negate: op === 'neq' });
    if (!clause) return null;
    clauses.push(clause);
  }

  const order = String(params.get('order') || '').trim();
  const orderSql = [];
  if (order) {
    for (const part of order.split(',').filter(Boolean)) {
      const bits = part.split('.');
      const field = safeJsonField(bits[0]);
      if (!field || !SQL_READ_ORDER_FIELDS.has(field)) return null;
      const direction = bits[1] === 'desc' ? 'desc' : 'asc';
      if (bits[1] && bits[1] !== 'asc' && bits[1] !== 'desc') return null;
      if (bits.some(bit => ![field, 'asc', 'desc', 'nullsfirst', 'nullslast'].includes(bit))) return null;
      const explicitNullsFirst = bits.includes('nullsfirst');
      const nulls = explicitNullsFirst
        ? (direction === 'desc' ? 'nulls last' : 'nulls first')
        : (direction === 'desc' ? 'nulls first' : 'nulls last');
      orderSql.push(`(payload ->> '${field}')::timestamptz ${direction} ${nulls}`);
    }
  }

  const { offset, limit } = readWindow(params, headers);
  return { clauses, orderSql, offset, limit, values };
}

async function loadReadRows(client, table, params, headers = new Headers()) {
  const plan = buildSqlReadPlan(params, headers);
  if (!plan) return null;
  const values = [table, ...plan.values];
  const where = plan.clauses.length ? `and ${plan.clauses.join(' and ')}` : '';
  const order = plan.orderSql.length ? `order by ${plan.orderSql.join(', ')}` : '';
  let limit = '';
  if (Number.isFinite(plan.limit) && plan.limit >= 0) {
    values.push(plan.limit);
    limit = `limit $${values.length}`;
  }
  let offset = '';
  if (plan.offset > 0) {
    values.push(plan.offset);
    offset = `offset $${values.length}`;
  }

  const result = await client.query({
    text: `
      /* sql-filtered-v3 */
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
      ), filtered as (
        select row_key, payload
        from combined
        where operation <> 'delete' ${where}
      )
      select page.row_key, page.payload, totals.total
      from (select count(*)::integer total from filtered) totals
      left join lateral (
        select row_key, payload from filtered
        ${order}
        ${limit}
        ${offset}
      ) page on true
    `,
    values,
  });

  // Keep a compatibility fallback for test doubles and old proxies that do not
  // return the page+total shape. Production pg returns this shape directly.
  if (!Array.isArray(result?.rows) || !result.rows.length || !Object.prototype.hasOwnProperty.call(result.rows[0], 'total')) {
    return null;
  }
  const total = Number(result.rows[0]?.total || 0);
  const rows = result.rows
    .filter(item => item?.payload != null)
    .map(item => {
      const payload = normalizeFailoverRow(table, item.payload);
      if (payload && typeof payload === 'object') {
        Object.defineProperty(payload, ROW_KEY, { value: String(item.row_key), enumerable: false });
      }
      return payload;
    });
  return { rows, total, offset: plan.offset };
}

''' + anchor
source = replace_once(source, anchor, helpers, 'insert SQL-side read planner')

execute_old = r'''  const execute = async () => {
    const allRows = await loadRows(client, table);
    const matched = applyFilters(allRows, url.searchParams);
    const prefer = headers.get('prefer') || '';

    if (method === 'GET' || method === 'HEAD') {'''
execute_new = r'''  const execute = async () => {
    if (method === 'GET' || method === 'HEAD') {
      const optimized = await loadReadRows(client, table, url.searchParams, headers);
      if (optimized) {
        if (method === 'HEAD') return jsonResponse(null, 200, { 'Content-Range': `0-0/${optimized.total}` });
        return formatReadResponse(projectRows(optimized.rows, url.searchParams.get('select')), headers, optimized.total, optimized.offset);
      }
    }

    const allRows = await loadRows(client, table);
    const matched = applyFilters(allRows, url.searchParams);
    const prefer = headers.get('prefer') || '';

    if (method === 'GET' || method === 'HEAD') {'''
source = replace_once(source, execute_old, execute_new, 'use SQL-side GET before full snapshot')

exports_old = """module.exports = {
  activateApiProfile,
  applyFilters,
  applyOrder,"""
exports_new = """module.exports = {
  activateApiProfile,
  applyFilters,
  applyOrder,
  buildSqlReadPlan,"""
source = replace_once(source, exports_old, exports_new, 'export SQL read planner')
source = replace_once(source, "  matchFilter,\n", "  loadReadRows,\n  matchFilter,\n", 'export SQL read loader')
patch_path.write_text(source)

runtime = Path('runtimeBootstrap.js')
runtime_text = runtime.read_text()
runtime_text = replace_once(runtime_text, "neon_failover_reads: 'unbounded-snapshot-v2'", "neon_failover_reads: 'sql-filtered-v3'", 'update health marker')
runtime.write_text(runtime_text)

test_path = Path('tests/neonFailoverFetchPatch.test.js')
test = test_path.read_text()
test = replace_once(test, """  applyOrder,
  claimDailyJournal,""", """  applyOrder,
  buildSqlReadPlan,
  claimDailyJournal,""", 'import planner')
test = replace_once(test, """  inferTableDefaults,
  matchFilter,""", """  inferTableDefaults,
  loadReadRows,
  matchFilter,""", 'import loader')

test_anchor = "test('infers numeric and UUID ids without mutating input', () => {"
new_tests = r'''test('simple failover reads push filters, time ordering and pagination into Neon SQL', async () => {
  const calls = [];
  const client = {
    async query(statement) {
      calls.push(statement);
      assert.match(statement.text, /sql-filtered-v3/);
      assert.match(statement.text, /payload -> 'session_id'/);
      assert.match(statement.text, /payload -> 'visible'/);
      assert.match(statement.text, /payload ->> 'created_at'/);
      assert.match(statement.text, /limit \$\d+/);
      return {
        rows: [{
          row_key: '9001',
          payload: { id: 9001, session_id: 22, role: 'user', content: 'latest', visible: true, created_at: '2026-08-10T09:00:00Z' },
          total: 7,
        }],
      };
    },
  };
  const response = await handleTableRequest(
    client,
    new URL('https://project.supabase.co/rest/v1/messages?session_id=eq.22&visible=eq.true&order=created_at.desc&limit=1&select=id,content'),
    'GET',
    new Headers(),
    null,
  );
  assert.equal(calls.length, 1, 'optimized GET must not load the full table first');
  assert.deepEqual(calls[0].values.slice(0, 3), ['messages', '22', 'true']);
  assert.equal(response.headers.get('Content-Range'), '0-0/7');
  assert.deepEqual(await response.json(), [{ id: 9001, content: 'latest' }]);
});

test('API profile health reads use SQL-side boolean filtering and limit one', () => {
  const plan = buildSqlReadPlan(new URLSearchParams('is_active=eq.true&limit=1'), new Headers());
  assert.ok(plan);
  assert.deepEqual(plan.values, ['true']);
  assert.equal(plan.limit, 1);
  assert.match(plan.clauses[0], /payload -> 'is_active'/);
});

test('complex PostgREST expressions keep the legacy JS fallback for correctness', async () => {
  assert.equal(buildSqlReadPlan(new URLSearchParams('or=(role.eq.user,visible.eq.true)&limit=2'), new Headers()), null);
  const calls = [];
  const client = {
    async query(statement) {
      calls.push(statement);
      if (/sql-filtered-v3/.test(statement.text)) throw new Error('complex filter must not use SQL fast path');
      if (/with latest_changes/.test(statement.text)) {
        return { rows: [{ row_key: '1', payload: { id: 1, role: 'user', visible: true } }] };
      }
      throw new Error(`Unexpected query: ${statement.text}`);
    },
  };
  const response = await handleTableRequest(
    client,
    new URL('https://project.supabase.co/rest/v1/messages?or=(role.eq.user,visible.eq.true)&limit=2'),
    'GET',
    new Headers(),
    null,
  );
  assert.equal(calls.length, 1);
  assert.equal(response.status, 200);
});

test('SQL read loader preserves empty pages and total counts', async () => {
  const client = {
    async query(statement) {
      assert.match(statement.text, /sql-filtered-v3/);
      return { rows: [{ row_key: null, payload: null, total: 12 }] };
    },
  };
  const result = await loadReadRows(client, 'messages', new URLSearchParams('visible=eq.true&offset=20&limit=10'), new Headers());
  assert.deepEqual(result, { rows: [], total: 12, offset: 20 });
});

''' + test_anchor
if test_anchor not in test:
    raise SystemExit('test insertion anchor missing')
test = test.replace(test_anchor, new_tests, 1)
test_path.write_text(test)

marker_path = Path('tests/runtimeUploadPrivacyGuard.test.js')
marker = marker_path.read_text()
marker = replace_once(marker, "/neon_failover_reads:\\s*'unbounded-snapshot-v2'/", "/neon_failover_reads:\\s*'sql-filtered-v3'/", 'update marker test')
marker_path.write_text(marker)
