'use strict';

const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { readOssStorageConfig, createOssStorage, safeMessage } = require('../ossStorage');
const { buildCleanupPlan, loadProtectedPaths } = require('../photoRetention');

const HASH_HEADER = 'x-oss-meta-ourhome-sha256';
const SOURCE_UPDATED_HEADER = 'x-oss-meta-ourhome-source-updated-at';
const DEFAULT_BUCKET = 'uploads';
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RETENTION_DAYS = 30;

function clean(value) {
  return String(value || '').trim();
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = new Set(argv);
  const valueAfter = flag => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : '';
  };
  return {
    apply: args.has('--apply'),
    includeExpired: args.has('--all'),
    bucket: clean(valueAfter('--bucket')) || clean(process.env.OURHOME_UPLOAD_BUCKET) || DEFAULT_BUCKET,
    concurrency: Math.min(5, positiveInteger(valueAfter('--concurrency'), DEFAULT_CONCURRENCY)),
    limit: positiveInteger(valueAfter('--limit'), Infinity),
    batch: positiveInteger(valueAfter('--batch'), Infinity),
    retentionDays: positiveInteger(valueAfter('--retention-days'), positiveInteger(process.env.CHAT_PHOTO_RETENTION_DAYS, DEFAULT_RETENTION_DAYS)),
  };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function headerValue(headers, name) {
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) return clean(value);
  }
  return '';
}

function sourceCredentials(env = process.env) {
  const url = clean(env.SUPABASE_URL);
  const key = clean(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_KEY);
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  return { url, key };
}

async function listSupabaseObjects(fileApi, { maxObjects = Infinity } = {}) {
  const objects = [];
  const folders = [''];
  const visited = new Set();

  while (folders.length && objects.length < maxObjects) {
    const prefix = folders.shift();
    if (visited.has(prefix)) continue;
    visited.add(prefix);

    for (let offset = 0; objects.length < maxObjects; offset += 1000) {
      const { data, error } = await fileApi.list(prefix, {
        limit: 1000,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) throw error;
      const entries = Array.isArray(data) ? data : [];
      for (const entry of entries) {
        const name = clean(entry?.name);
        if (!name || name === '.emptyFolderPlaceholder') continue;
        const path = prefix ? `${prefix}/${name}` : name;
        const isFolder = entry?.id == null && entry?.metadata == null;
        if (isFolder) folders.push(path);
        else objects.push({
          path,
          size: Number(entry?.metadata?.size || 0),
          contentType: clean(entry?.metadata?.mimetype) || 'application/octet-stream',
          updatedAt: clean(entry?.updated_at || entry?.updatedAt || entry?.created_at),
        });
        if (objects.length >= maxObjects) break;
      }
      if (entries.length < 1000) break;
    }
  }
  return objects;
}

async function downloadSource(fileApi, source) {
  const { data, error } = await fileApi.download(source.path);
  if (error) throw error;
  const bytes = Buffer.from(await data.arrayBuffer());
  if (source.size > 0 && bytes.length !== source.size) {
    throw new Error(`source size changed during migration (${source.size} -> ${bytes.length})`);
  }
  return bytes;
}

async function inspectTarget(oss, source) {
  const head = await oss.headObject(source.path);
  if (!head) return { state: 'missing', head: null, hash: '' };
  const hash = headerValue(head.headers, HASH_HEADER);
  const sourceUpdatedAt = headerValue(head.headers, SOURCE_UPDATED_HEADER);
  if (source.size > 0 && head.size !== source.size) return { state: 'different-size', head, hash, sourceUpdatedAt };
  if (source.updatedAt && sourceUpdatedAt === source.updatedAt && hash) {
    return { state: 'verified-marker', head, hash, sourceUpdatedAt };
  }
  return { state: hash ? 'hashed' : 'needs-hash-check', head, hash, sourceUpdatedAt };
}

async function migrateOne({ fileApi, oss, source, apply }) {
  const target = await inspectTarget(oss, source);
  if (!apply) return { action: target.state === 'missing' ? 'would-copy' : `would-check-${target.state}`, bytes: source.size };
  if (target.state === 'verified-marker') return { action: 'verified-marker', bytes: source.size };

  const sourceBytes = await downloadSource(fileApi, source);
  const sourceHash = sha256(sourceBytes);
  if (target.state === 'hashed' && target.hash === sourceHash) {
    if (source.updatedAt && target.sourceUpdatedAt !== source.updatedAt) {
      await oss.putObject(source.path, sourceBytes, {
        contentType: source.contentType,
        metadata: { [HASH_HEADER]: sourceHash, [SOURCE_UPDATED_HEADER]: source.updatedAt },
      });
      return { action: 'verified-and-stamped', bytes: sourceBytes.length };
    }
    return { action: 'verified', bytes: sourceBytes.length };
  }

  if (target.state === 'needs-hash-check') {
    const existing = await oss.getObject(source.path);
    if (sha256(existing.bytes) === sourceHash) {
      // Re-uploading identical bytes records a durable hash for all later resumptions.
      await oss.putObject(source.path, sourceBytes, {
        contentType: source.contentType || existing.contentType,
        metadata: {
          [HASH_HEADER]: sourceHash,
          ...(source.updatedAt ? { [SOURCE_UPDATED_HEADER]: source.updatedAt } : {}),
        },
      });
      return { action: 'verified-and-stamped', bytes: sourceBytes.length };
    }
  }

  await oss.putObject(source.path, sourceBytes, {
    contentType: source.contentType,
    metadata: {
      [HASH_HEADER]: sourceHash,
      ...(source.updatedAt ? { [SOURCE_UPDATED_HEADER]: source.updatedAt } : {}),
    },
  });
  const verified = await oss.headObject(source.path);
  const verifiedHash = headerValue(verified?.headers, HASH_HEADER);
  const verifiedSourceUpdatedAt = headerValue(verified?.headers, SOURCE_UPDATED_HEADER);
  if (
    !verified
    || verified.size !== sourceBytes.length
    || verifiedHash !== sourceHash
    || (source.updatedAt && verifiedSourceUpdatedAt !== source.updatedAt)
  ) {
    throw new Error('target verification failed after upload');
  }
  return { action: target.state === 'missing' ? 'copied' : 'repaired', bytes: sourceBytes.length };
}

async function selectRetainedObjects(supabase, inventory, {
  retentionDays = DEFAULT_RETENTION_DAYS,
  now = new Date(),
} = {}) {
  const cutoffMs = now.getTime() - Math.max(1, Number(retentionDays) || DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  const { data: messages, error } = await supabase.from('messages')
    .select('id,created_at,attachment_url,attachment_type,attachment_name,attachment_summary')
    .not('attachment_url', 'is', null);
  if (error) throw error;
  const protectedPaths = await loadProtectedPaths(supabase);
  const objectSizes = new Map(inventory.map(item => [item.path, item.size]));
  const expiredPlan = buildCleanupPlan({ messages: messages || [], protectedPaths, cutoffMs, objectSizes });
  const expiredPaths = new Set(expiredPlan.map(item => item.path));
  return {
    selected: inventory.filter(item => !expiredPaths.has(item.path)),
    expired: inventory.filter(item => expiredPaths.has(item.path)),
    protectedPaths,
  };
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        results[index] = { action: 'error', bytes: items[index].size, error: safeMessage(error) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, next));
  return results;
}

async function migrate({ env = process.env, argv = process.argv.slice(2), logger = console } = {}) {
  const options = parseArgs(argv);
  const source = sourceCredentials(env);
  const rawOssConfig = readOssStorageConfig(env);
  if (!rawOssConfig.configured) {
    throw new Error('ALIYUN_OSS_REGION, ALIYUN_OSS_ACCESS_KEY_ID, ALIYUN_OSS_ACCESS_KEY_SECRET and ALIYUN_OSS_BUCKET are required');
  }

  const supabase = createClient(source.url, source.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const fileApi = supabase.storage.from(options.bucket);
  const oss = createOssStorage({
    config: { ...rawOssConfig, mode: 'primary', enabled: true, primary: true },
  });

  logger.log(`[storage-migration] ${options.apply ? 'APPLY' : 'DRY RUN'}: inventorying ${options.bucket}`);
  const inventory = await listSupabaseObjects(fileApi, { maxObjects: options.limit });
  let selection = { selected: inventory, expired: [], protectedPaths: new Set() };
  if (!options.includeExpired) {
    try {
      selection = await selectRetainedObjects(supabase, inventory, { retentionDays: options.retentionDays });
    } catch (error) {
      logger.warn(`[storage-migration] retention selection unavailable; preserving everything: ${safeMessage(error)}`);
    }
  }

  let workItems = selection.selected;
  let verifiedMarkers = 0;
  let pendingBeforeBatch = workItems.length;
  if (options.apply && Number.isFinite(options.batch)) {
    const inspections = await runPool(workItems, options.concurrency, item => inspectTarget(oss, item));
    const pending = [];
    inspections.forEach((target, index) => {
      if (target?.state === 'verified-marker') verifiedMarkers += 1;
      else pending.push(workItems[index]);
    });
    pendingBeforeBatch = pending.length;
    workItems = pending.slice(0, options.batch);
  }

  const results = await runPool(workItems, options.concurrency, item => migrateOne({
    fileApi,
    oss,
    source: item,
    apply: options.apply,
  }));
  const summary = {
    mode: options.apply ? 'apply' : 'dry-run',
    bucket: options.bucket,
    sourceObjects: inventory.length,
    objects: selection.selected.length,
    bytes: selection.selected.reduce((total, item) => total + item.size, 0),
    skippedExpiredObjects: selection.expired.length,
    skippedExpiredBytes: selection.expired.reduce((total, item) => total + item.size, 0),
    protectedObjects: selection.protectedPaths.size,
    processedObjects: workItems.length,
    remainingObjects: Math.max(0, pendingBeforeBatch - workItems.length),
    actions: verifiedMarkers ? { 'verified-marker': verifiedMarkers } : {},
    errors: [],
  };
  results.forEach((result, index) => {
    summary.actions[result.action] = (summary.actions[result.action] || 0) + 1;
    if (result.error) summary.errors.push({ path: workItems[index].path, message: result.error });
  });
  logger.log(JSON.stringify(summary, null, 2));
  if (summary.errors.length) throw new Error(`${summary.errors.length} object(s) failed; rerun is safe and resumable`);
  return summary;
}

if (require.main === module) {
  migrate().catch(error => {
    console.error(`[storage-migration] stopped safely: ${safeMessage(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  HASH_HEADER,
  SOURCE_UPDATED_HEADER,
  parseArgs,
  sha256,
  headerValue,
  listSupabaseObjects,
  inspectTarget,
  migrateOne,
  selectRetainedObjects,
  runPool,
  migrate,
};
