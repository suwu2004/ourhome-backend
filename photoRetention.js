'use strict';

const { parseUploadObjectUrl } = require('./privateUploads');
const { compressImageBuffer, DEFAULT_MIN_BYTES } = require('./imageCompression');

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

function buildCleanupPlan({ messages = [], protectedPaths = new Set(), cutoffMs, objectSizes = null, minBytes = DEFAULT_MIN_BYTES }) {
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
    if (objectSizes && (!Number.isFinite(bytes) || bytes < minBytes)) continue;
    if (!rows.length || !rows.every(row => isImageMessage(row) && olderThan(row.created_at, cutoffMs))) continue;
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

async function blobToBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value?.arrayBuffer === 'function') return Buffer.from(await value.arrayBuffer());
  throw new Error('unsupported storage download body');
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

async function runPhotoRetentionOptimization({
  supabase,
  retentionDays = DEFAULT_RETENTION_DAYS,
  now = new Date(),
  bucket = 'uploads',
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  if (!supabase) throw new Error('photo retention requires supabase');
  const days = Math.max(1, Number(retentionDays) || DEFAULT_RETENTION_DAYS);
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  const { data: messages, error } = await supabase.from('messages')
    .select('id,created_at,attachment_url,attachment_type,attachment_name')
    .not('attachment_url', 'is', null);
  if (error) throw error;

  const protectedPaths = await loadProtectedPaths(supabase);
  const storage = supabase.storage.from(bucket);
  const objectSizes = await listUploadObjectSizes(storage);
  const plan = buildCleanupPlan({ messages: messages || [], protectedPaths, cutoffMs, objectSizes })
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, Math.max(1, Number(batchSize) || DEFAULT_BATCH_SIZE));
  if (!plan.length) return { optimizedObjects: 0, savedBytes: 0, protectedObjects: protectedPaths.size, candidates: 0 };

  let optimizedObjects = 0;
  let savedBytes = 0;
  let skippedObjects = 0;
  for (const item of plan) {
    const { data, error: downloadError } = await storage.download(item.path);
    if (downloadError) throw downloadError;
    const original = await blobToBuffer(data);
    const optimized = await compressImageBuffer(original, item.contentType, { minBytes: 1 });
    if (!optimized.compressed) {
      skippedObjects += 1;
      continue;
    }
    const { error: updateError } = await storage.update(item.path, optimized.buffer, {
      contentType: optimized.contentType || item.contentType,
      upsert: true,
    });
    if (updateError) throw updateError;
    optimizedObjects += 1;
    savedBytes += optimized.savedBytes || Math.max(0, original.length - optimized.buffer.length);
  }
  return {
    optimizedObjects,
    savedBytes,
    skippedObjects,
    protectedObjects: protectedPaths.size,
    candidates: plan.length,
  };
}

// Keep the old export name for the deployed patch and any maintenance scripts.
const runPhotoRetentionCleanup = runPhotoRetentionOptimization;

function startPhotoRetentionScheduler({
  supabase,
  retentionDays = DEFAULT_RETENTION_DAYS,
  firstDelayMs = 5 * 60 * 1000,
  intervalMs = 12 * 60 * 60 * 1000,
} = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runPhotoRetentionOptimization({ supabase, retentionDays });
      if (result.optimizedObjects) {
        console.log(`[photo-retention] compressed ${result.optimizedObjects} old chat images; saved ${result.savedBytes} bytes`);
      }
    } catch (error) {
      console.warn('[photo-retention] compression skipped:', error?.message || error);
    } finally {
      running = false;
    }
  };

  const first = setTimeout(run, Math.max(0, firstDelayMs));
  first.unref?.();
  const timer = setInterval(run, Math.max(60 * 60 * 1000, intervalMs));
  timer.unref?.();
  return { run, stop() { clearTimeout(first); clearInterval(timer); } };
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  isImageMessage,
  uploadPath,
  collectUploadPaths,
  buildCleanupPlan,
  listUploadObjectSizes,
  loadProtectedPaths,
  runPhotoRetentionOptimization,
  runPhotoRetentionCleanup,
  startPhotoRetentionScheduler,
};
