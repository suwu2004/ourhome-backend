const EXTRA_BACKUP_TABLES = [
  { key: 'reading_annotations', table: 'reading_annotations', order: ['created_at', true], limit: 20000 },
  { key: 'reading_notes', table: 'reading_notes', order: ['created_at', true], limit: 20000 },
  { key: 'reading_chapter_notes', table: 'reading_chapter_notes', order: ['chapter_index', true], limit: 20000 },
  { key: 'reading_ai_runs', table: 'reading_ai_runs', order: ['created_at', true], limit: 20000 },
  { key: 'daily_summaries', table: 'daily_summaries', order: ['summary_date', true], limit: 5000 },
  { key: 'memory_marks', table: 'memory_marks', order: ['created_at', true], limit: 20000 },
  { key: 'memory_events', table: 'memory_events', order: ['created_at', true], limit: 20000 },
  { key: 'session_summaries', table: 'session_summaries', order: ['updated_at', true], limit: 5000 },
  { key: 'milestones', table: 'milestones', order: ['date', true], limit: 5000 },
  { key: 'theater_rules', table: 'theater_rules', order: ['updated_at', true], limit: 5000 },
  { key: 'phone_calls', table: 'phone_calls', order: ['created_at', true], limit: 5000 },
];

function missingRelation(error) {
  return ['42P01', 'PGRST205', 'PGRST202'].includes(error?.code);
}

async function readExtraBackupTable(supabase, { table, order, limit }) {
  let query = supabase.from(table).select('*');
  if (order) query = query.order(order[0], { ascending: order[1] });
  if (limit) query = query.limit(limit);
  const { data, error } = await query;
  if (error) {
    if (missingRelation(error)) return { rows: [], unavailable: error.message };
    throw error;
  }
  return { rows: data || [] };
}

async function enrichBackupPayload(supabase, payload) {
  if (!payload || typeof payload !== 'object' || payload.app !== 'OurHome') return payload;
  const results = await Promise.all(EXTRA_BACKUP_TABLES.map(item => readExtraBackupTable(supabase, item)));
  const extraTables = {};
  EXTRA_BACKUP_TABLES.forEach((item, index) => {
    extraTables[item.key] = results[index];
  });
  return {
    ...payload,
    version: Math.max(Number(payload.version) || 1, 2),
    tables: { ...(payload.tables || {}), ...extraTables },
    note: [
      payload.note,
      '备份已包含共读划线、陆泽书签、章节预读、今日摘要、未完待续、窗口简介、重要时刻、小剧场规则和通话记录。',
    ].filter(Boolean).join(' '),
  };
}

function createBackupEnrichmentMiddleware({ supabase }) {
  return function backupEnrichmentMiddleware(req, res, next) {
    if (req.method !== 'GET') return next();

    const originalSend = res.send.bind(res);
    let handled = false;
    res.send = function sendEnrichedBackup(body) {
      if (handled || res.statusCode >= 400) return originalSend(body);
      handled = true;

      Promise.resolve()
        .then(async () => {
          const payload = typeof body === 'string' ? JSON.parse(body) : body;
          const enriched = await enrichBackupPayload(supabase, payload);
          return typeof body === 'string' ? JSON.stringify(enriched, null, 2) : enriched;
        })
        .then(originalSend)
        .catch(error => {
          console.error('补全备份内容失败，继续导出基础备份:', error.message);
          originalSend(body);
        });
      return res;
    };

    return next();
  };
}

function registerBackupEnrichment(app, { supabase }) {
  app.use('/backup', createBackupEnrichmentMiddleware({ supabase }));
}

module.exports = {
  EXTRA_BACKUP_TABLES,
  enrichBackupPayload,
  createBackupEnrichmentMiddleware,
  registerBackupEnrichment,
};
