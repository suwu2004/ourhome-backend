'use strict';

const { parseUploadObjectUrl } = require('./privateUploads');

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_DB_PAGE_SIZE = 500;
const IMAGE_EXT_RE = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|webp)(?:$|[?#])/i;

function isImageMessage(row) {
  const type = String(row?.attachment_type || '').toLowerCase();
  if (type === 'image/removed') return false;
  if (type.startsWith('image/')) return true;
  return !type && IMAGE_EXT_RE.test(String(row?.attachment_url || row?.attachment_name || ''));
}

function uploadPath(value) {
  return parseUploadObjectUrl(String(value || ''))?.path || '';
}

function collectUploadPaths(value, target = new Set(), seen = new WeakSet()) {
  if (typeof value === 'string') {
    const direct = uploadPath(value);
    if (direct) target.add(direct);
    const matches = value.match(/https?:\/\/[^\s"'<>\\]+\/storage\/v1\/object\/(?:public|sign)\/uploads\/[^\s"'<>\\]+/g) || [];
    for (const match of matches) {
      const path = uploadPath(match);
      if (path) target.add(path);
    }
    return target;
  }
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || seen.has(value)) return target;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach(item => collectUploadPaths(item, target, seen));
    return target;
  }
  Object.values(value).forEach(item => collectUploadPaths(item, target, seen));
  return target;
}

function olderThan(value, cutoffMs) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) && time < cutoffMs;
}

function hasDurableImageAnalysis(row) {
  return Boolean(String(row?.attachment_summary || '').trim());
}

function buildCleanupPlan({ messages = [], protectedPaths = new Set(), cutoffMs, objectSizes = null }) {
  const byPath = new Map();
  for (const row of messages) {
    const path = uploadPath(row?.attachment_url);
    if (!path) continue;
    const rows = byPath.get(path) || [];
    rows.push(row);
    byPath.set(path, rows);
  }

  const plan = [];
  for (const [path, rows] of byPath.entries()) {
    if (protectedPaths.has(path)) continue;
    const bytes = objectSizes?.get(path);
    if (!rows.length || !rows.every(row => (
      isImageMessage(row)
      && olderThan(row.created_at, cutoffMs)
      && hasDurableImageAnalysis(row)
    ))) continue;
    plan.push({
      path,
      messageIds: rows.map(row => row.id),
      contentType: String(rows.find(row => row.attachment_type)?.attachment_type || ''),
      bytes: Number.isFinite(bytes) ? bytes : 0,
    });
  }
  return plan;
}

async function listUploadObjectSizes(storage, { pageSize = 1000 } = {}) {
  const sizes = new Map();
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await storage.list('', { limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw error;
    for (const item of data || []) {
      const size = Number(item?.metadata?.size);
      if (item?.name && Number.isFinite(size)) sizes.set(item.name, size);
    }
    if (!data || data.length < pageSize) break;
  }
  return sizes;
}

async function readOptionalRows(supabase, table, columns, orderColumn = 'id') {
  const rows = [];
  for (let offset = 0; ; offset += DEFAULT_DB_PAGE_SIZE) {
    let query = supabase.from(table).select(columns);
    if (orderColumn && typeof query.order === 'function') {
      query = query.order(orderColumn, { ascending: true });
    }
    if (typeof query.range === 'function') {
      query = query.range(offset, offset + DEFAULT_DB_PAGE_SIZE - 1);
    }

    const { data, error } = await query;
    if (error) {
      if (['42P01', 'PGRST205', 'PGRST202'].includes(error.code)) return [];
      throw error;
    }
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    // Lightweight test doubles and older adapters may not expose range().
    if (page.length < DEFAULT_DB_PAGE_SIZE || typeof query.range !== 'function') break;
  }
  return rows;
}

async function readMessageAttachmentRows(supabase) {
  const rows = [];
  const columns = 'id,created_at,attachment_url,attachment_type,attachment_name,attachment_summary';
  for (let offset = 0; ; offset += DEFAULT_DB_PAGE_SIZE) {
    let query = supabase.from('messages').select(columns).not('attachment_url', 'is', null);
    if (typeof query.order === 'function') {
      query = query.order('created_at', { ascending: true }).order('id', { ascending: true });
    }
    if (typeof query.range === 'function') {
      query = query.range(offset, offset + DEFAULT_DB_PAGE_SIZE - 1);
    }
    const { data, error } = await query;
    if (error) throw error;
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < DEFAULT_DB_PAGE_SIZE || typeof query.range !== 'function') break;
  }
  return rows;
}

async function loadProtectedPaths(supabase) {
  const protectedPaths = new Set();
  // A shared uploads object must not be removed merely because its chat attachment
  // aged out. Scan every feature that can persist an upload URL, and page each
  // query so Supabase's default 1,000-row response limit cannot hide references.
  const scans = [
    ['letters', 'content', 'id'],
    ['settings', 'my_avatar_url,partner_avatar_url,bg_image_url,whisper_bg_image_url,home_bg_day_image_url,home_bg_night_image_url,home_memo_bg_image_url', 'session_id'],
    ['memory_favorites', 'source_url,content,metadata', 'id'],
    ['toybox_runs', 'state,result', 'id'],
    ['toybox_events', 'payload', 'id'],
    ['memories', 'summary,metadata', 'id'],
    ['memory_core', 'summary,metadata', 'id'],
    ['memory_episodic', 'summary,metadata', 'id'],
    ['memory_events', 'summary,metadata', 'id'],
    ['memory_working', 'summary,metadata', 'id'],
    ['daily_summaries', 'summary,highlights,open_threads,metadata', 'summary_date'],
    ['drawing_history', 'image_path,metadata', 'id'],
    ['luze_private_entries', 'source_url,body,metadata', 'id'],
    ['home_memos', 'content', 'id'],
    ['calendar_entries', 'content', 'id'],
    ['reading_notes', 'quote,content', 'id'],
    ['reading_annotations', 'quote,prefix,suffix,note,luze_reply', 'id'],
  ];
  const datasets = await Promise.all(scans.map(([table, columns, orderColumn]) =>
    readOptionalRows(supabase, table, columns, orderColumn)
  ));
  for (const rows of datasets) collectUploadPaths(rows, protectedPaths);
  return protectedPaths;
}

async function removeFromStorage(storage, path) {
  if (!storage || typeof storage.remove !== 'function') return;
  const { error } = await storage.remove([path]);
  if (error) throw error;
}

async function markImageBytesRemoved(supabase, messageIds) {
  if (!messageIds.length) return;
  const { error } = await supabase.from('messages')
    .update({ attachment_url: null, attachment_type: 'image/removed' })
    .in('id', messageIds);
  if (error) throw error;
}

async function runPhotoRetentionCleanup({
  supabase,
  sourceStorage = null,
  retentionDays = DEFAULT_RETENTION_DAYS,
  now = new Date(),
  bucket = 'uploads',
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  if (!supabase) throw new Error('photo retention requires supabase');
  const days = Math.max(1, Number(retentionDays) || DEFAULT_RETENTION_DAYS);
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  const messages = await readMessageAttachmentRows(supabase);
  const protectedPaths = await loadProtectedPaths(supabase);
  const storage = supabase.storage.from(bucket);
  const objectSizes = await listUploadObjectSizes(storage);
  const plan = buildCleanupPlan({ messages, protectedPaths, cutoffMs, objectSizes })
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, Math.max(1, Number(batchSize) || DEFAULT_BATCH_SIZE));
  if (!plan.length) return { deletedObjects: 0, releasedBytes: 0, protectedObjects: protectedPaths.size, candidates: 0 };

  let deletedObjects = 0;
  let releasedBytes = 0;
  for (const item of plan) {
    // Delete the legacy Supabase copy first. If its quota still blocks writes,
    // leave the database reference and OSS object untouched so the retry is safe.
    if (sourceStorage && sourceStorage !== storage) await removeFromStorage(sourceStorage, item.path);
    await removeFromStorage(storage, item.path);
    // The verified image analysis remains in attachment_summary. Clearing only
    // the byte URL prevents a broken image while preserving conversation memory.
    await markImageBytesRemoved(supabase, item.messageIds);
    deletedObjects += 1;
    releasedBytes += item.bytes;
  }
  return {
    deletedObjects,
    releasedBytes,
    protectedObjects: protectedPaths.size,
    candidates: plan.length,
  };
}

// Keep the old export name for compatibility with one-off maintenance callers.
const runPhotoRetentionOptimization = runPhotoRetentionCleanup;

function startPhotoRetentionScheduler({
  supabase,
  sourceStorage = null,
  retentionDays = DEFAULT_RETENTION_DAYS,
  firstDelayMs = 5 * 60 * 1000,
  intervalMs = 12 * 60 * 60 * 1000,
  retryDelayMs = 15 * 60 * 1000,
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  let running = false;
  let retryTimer = null;
  const scheduleRetry = () => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(run, Math.max(5 * 60 * 1000, retryDelayMs));
    retryTimer.unref?.();
  };
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runPhotoRetentionCleanup({ supabase, sourceStorage, retentionDays, batchSize });
      if (result.deletedObjects) {
        console.log(`[photo-retention] deleted ${result.deletedObjects} expired chat images; released ${result.releasedBytes} bytes while preserving analyses`);
      }
      // A full batch probably means more eligible photos remain. Continue soon,
      // while keeping ordinary maintenance on the quiet twelve-hour interval.
      if (result.candidates >= batchSize) scheduleRetry();
    } catch (error) {
      console.warn('[photo-retention] cleanup skipped safely:', error?.message || error);
      // Quota restrictions can disappear shortly after a billing-cycle reset.
      // One lightweight retry is enough; the scheduler never loops aggressively.
      scheduleRetry();
    } finally {
      running = false;
    }
  };

  const first = setTimeout(run, Math.max(0, firstDelayMs));
  first.unref?.();
  const timer = setInterval(run, Math.max(60 * 60 * 1000, intervalMs));
  timer.unref?.();
  return { run, stop() { clearTimeout(first); clearTimeout(retryTimer); clearInterval(timer); } };
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  isImageMessage,
  hasDurableImageAnalysis,
  uploadPath,
  collectUploadPaths,
  buildCleanupPlan,
  listUploadObjectSizes,
  loadProtectedPaths,
  readOptionalRows,
  readMessageAttachmentRows,
  removeFromStorage,
  markImageBytesRemoved,
  runPhotoRetentionOptimization,
  runPhotoRetentionCleanup,
  startPhotoRetentionScheduler,
};
