'use strict';

const { parseUploadObjectUrl } = require('./privateUploads');

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_BATCH_SIZE = 64;
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

async function readOptionalRows(supabase, table, columns) {
  const { data, error } = await supabase.from(table).select(columns);
  if (error) {
    if (['42P01', 'PGRST205', 'PGRST202'].includes(error.code)) return [];
    throw error;
  }
  return data || [];
}

async function loadProtectedPaths(supabase) {
  const protectedPaths = new Set();
  const [letters, settings, favorites, toyboxRuns] = await Promise.all([
    readOptionalRows(supabase, 'letters', 'content'),
    readOptionalRows(supabase, 'settings', 'my_avatar_url,partner_avatar_url,bg_image_url,whisper_bg_image_url,home_bg_day_image_url,home_bg_night_image_url,home_memo_bg_image_url'),
    readOptionalRows(supabase, 'memory_favorites', 'source_url,content,metadata'),
    readOptionalRows(supabase, 'toybox_runs', 'state,result'),
  ]);
  collectUploadPaths(letters, protectedPaths);
  collectUploadPaths(settings, protectedPaths);
  collectUploadPaths(favorites, protectedPaths);
  collectUploadPaths(toyboxRuns, protectedPaths);
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
  const { data: messages, error } = await supabase.from('messages')
    .select('id,created_at,attachment_url,attachment_type,attachment_name,attachment_summary')
    .not('attachment_url', 'is', null);
  if (error) throw error;

  const protectedPaths = await loadProtectedPaths(supabase);
  const storage = supabase.storage.from(bucket);
  const objectSizes = await listUploadObjectSizes(storage);
  const plan = buildCleanupPlan({ messages: messages || [], protectedPaths, cutoffMs, objectSizes })
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
  removeFromStorage,
  markImageBytesRemoved,
  runPhotoRetentionOptimization,
  runPhotoRetentionCleanup,
  startPhotoRetentionScheduler,
};
