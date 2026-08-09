'use strict';

const { parseUploadObjectUrl } = require('./privateUploads');

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_BATCH_SIZE = 40;
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

function buildCleanupPlan({ messages = [], protectedPaths = new Set(), cutoffMs }) {
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
    if (!rows.length || !rows.every(row => isImageMessage(row) && olderThan(row.created_at, cutoffMs))) continue;
    plan.push({ path, messageIds: rows.map(row => row.id) });
  }
  return plan;
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

async function runPhotoRetentionCleanup({
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
  const plan = buildCleanupPlan({ messages: messages || [], protectedPaths, cutoffMs });
  if (!plan.length) return { deletedObjects: 0, cleanedMessages: 0, protectedObjects: protectedPaths.size };

  let deletedObjects = 0;
  let cleanedMessages = 0;
  const storage = supabase.storage.from(bucket);

  for (let index = 0; index < plan.length; index += batchSize) {
    const batch = plan.slice(index, index + batchSize);
    const paths = batch.map(item => item.path);
    const { error: removeError } = await storage.remove(paths);
    if (removeError) throw removeError;

    const ids = batch.flatMap(item => item.messageIds);
    const { error: updateError } = await supabase.from('messages')
      .update({
        attachment_url: null,
        attachment_type: 'image/removed',
        attachment_name: '生活照已自动整理',
      })
      .in('id', ids);
    if (updateError) throw updateError;
    deletedObjects += paths.length;
    cleanedMessages += ids.length;
  }

  return { deletedObjects, cleanedMessages, protectedObjects: protectedPaths.size };
}

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
      const result = await runPhotoRetentionCleanup({ supabase, retentionDays });
      if (result.deletedObjects) {
        console.log(`[photo-retention] removed ${result.deletedObjects} old chat images; ${result.cleanedMessages} message references retired`);
      }
    } catch (error) {
      console.warn('[photo-retention] cleanup skipped:', error?.message || error);
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
  loadProtectedPaths,
  runPhotoRetentionCleanup,
  startPhotoRetentionScheduler,
};
