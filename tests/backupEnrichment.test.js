const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXTRA_BACKUP_TABLES,
  enrichBackupPayload,
  createBackupEnrichmentMiddleware,
} = require('../backupEnrichment');

function fakeSupabase() {
  return {
    from(table) {
      return {
        select() { return this; },
        order() { return this; },
        limit() { return Promise.resolve({ data: [{ table, id: `${table}-1` }], error: null }); },
      };
    },
  };
}

test('基础备份会补上后来新增的 OurHome 数据表', async () => {
  const payload = await enrichBackupPayload(fakeSupabase(), {
    version: 1,
    app: 'OurHome',
    tables: { messages: { rows: [{ id: 1 }] } },
    note: '不含密钥。',
  });

  assert.equal(payload.version, 2);
  assert.deepEqual(payload.tables.messages.rows, [{ id: 1 }]);
  for (const item of EXTRA_BACKUP_TABLES) {
    assert.equal(payload.tables[item.key].rows[0].table, item.table);
  }
  assert.match(payload.note, /共读划线/);
  assert.equal(Object.hasOwn(payload.tables, 'push_subscriptions'), false);
  assert.equal(Object.hasOwn(payload.tables, 'settings'), false);
});

test('非 OurHome JSON 不会被备份补全器改写', async () => {
  const payload = { app: 'other', untouched: true };
  assert.equal(await enrichBackupPayload(fakeSupabase(), payload), payload);
});

test('GET /backup 中间件会在原响应发送前补全 JSON', async () => {
  const middleware = createBackupEnrichmentMiddleware({ supabase: fakeSupabase() });
  const sent = [];
  const req = { method: 'GET' };
  const res = {
    statusCode: 200,
    send(body) { sent.push(body); return this; },
  };

  middleware(req, res, () => {
    res.send(JSON.stringify({ app: 'OurHome', version: 1, tables: {} }));
  });

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
  const payload = JSON.parse(sent[0]);
  assert.ok(payload.tables.reading_annotations);
  assert.ok(payload.tables.session_summaries);
});
