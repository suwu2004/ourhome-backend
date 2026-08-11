'use strict';

const DEFAULT_SIGNED_SECONDS = 24 * 60 * 60;

function clean(value) {
  return String(value || '').trim();
}

function normalizeMode(value) {
  const mode = clean(value).toLowerCase();
  return ['shadow', 'primary'].includes(mode) ? mode : 'disabled';
}

function readOssStorageConfig(env = process.env) {
  const region = clean(env.ALIYUN_OSS_REGION);
  const accessKeyId = clean(env.ALIYUN_OSS_ACCESS_KEY_ID);
  const accessKeySecret = clean(env.ALIYUN_OSS_ACCESS_KEY_SECRET);
  const bucket = clean(env.ALIYUN_OSS_BUCKET);
  const endpoint = clean(env.ALIYUN_OSS_ENDPOINT);
  const mode = normalizeMode(env.OURHOME_OSS_STORAGE_MODE);
  const configured = Boolean(region && accessKeyId && accessKeySecret && bucket);
  return {
    mode,
    configured,
    enabled: mode !== 'disabled' && configured,
    primary: mode === 'primary' && configured,
    region,
    accessKeyId,
    accessKeySecret,
    bucket,
    endpoint,
  };
}

function safeMessage(error) {
  return String(error?.message || error || 'unknown OSS error')
    .replace(/(accessKeyId|accessKeySecret|authorization)["'\s:=]+[^\s,"']+/gi, '$1=[redacted]')
    .slice(0, 500);
}

async function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body === 'string') return Buffer.from(body);
  if (typeof body?.arrayBuffer === 'function') return Buffer.from(await body.arrayBuffer());
  throw new Error('OSS upload body type is unsupported');
}

function createClient(config) {
  // Keep the SDK completely dormant while OSS is disabled. Besides faster cold
  // starts, this means an optional object-store outage cannot affect Plan A.
  const OSS = require('ali-oss');
  return new OSS({
    region: config.region,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    bucket: config.bucket,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    secure: true,
    timeout: '30s',
  });
}

function createOssStorage({
  config = readOssStorageConfig(),
  client = config.enabled ? createClient(config) : null,
} = {}) {
  async function putObject(path, body, { contentType = 'application/octet-stream', metadata = {} } = {}) {
    if (!config.enabled) return { skipped: true, reason: config.mode === 'disabled' ? 'disabled' : 'not-configured' };
    const bytes = await toBuffer(body);
    await client.put(String(path), bytes, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=2592000',
        ...metadata,
      },
    });
    return { ok: true, key: String(path), size: bytes.length };
  }

  async function getObject(path) {
    if (!config.enabled) return { skipped: true, reason: config.mode === 'disabled' ? 'disabled' : 'not-configured' };
    const result = await client.get(String(path));
    const bytes = Buffer.isBuffer(result?.content) ? result.content : Buffer.from(result?.content || '');
    return {
      ok: true,
      key: String(path),
      bytes,
      contentType: result?.res?.headers?.['content-type'] || 'application/octet-stream',
    };
  }

  async function removeObjects(paths = []) {
    const unique = [...new Set((paths || []).map(item => clean(item)).filter(Boolean))];
    if (!config.enabled) return { skipped: true, reason: config.mode === 'disabled' ? 'disabled' : 'not-configured', deleted: 0 };
    if (!unique.length) return { ok: true, deleted: 0 };
    await client.deleteMulti(unique, { quiet: true });
    return { ok: true, deleted: unique.length };
  }

  function signedUrl(path, expiresIn = DEFAULT_SIGNED_SECONDS) {
    if (!config.enabled) return '';
    return client.signatureUrl(String(path), {
      method: 'GET',
      expires: Math.max(60, Number(expiresIn) || DEFAULT_SIGNED_SECONDS),
    });
  }

  async function headObject(path) {
    if (!config.enabled) return null;
    try {
      const result = await client.head(String(path));
      return {
        size: Number(result?.res?.headers?.['content-length'] || 0),
        contentType: result?.res?.headers?.['content-type'] || '',
        headers: result?.res?.headers || {},
      };
    } catch (error) {
      if (Number(error?.status || error?.statusCode) === 404 || error?.code === 'NoSuchKey') return null;
      throw error;
    }
  }

  async function listObjects({ prefix = '', limit = 1000, offset = 0 } = {}) {
    if (!config.enabled) return [];
    const needed = Math.max(1, Number(offset) || 0) + Math.max(1, Number(limit) || 1000);
    const objects = [];
    let marker = '';
    do {
      const result = await client.list({
        prefix: String(prefix || ''),
        marker,
        'max-keys': Math.min(1000, needed - objects.length),
      });
      objects.push(...(result?.objects || []));
      marker = result?.nextMarker || '';
    } while (marker && objects.length < needed);
    return objects.slice(Math.max(0, Number(offset) || 0), needed).map(item => ({
      name: item.name,
      metadata: {
        size: Number(item.size || 0),
        mimetype: item.type || '',
        eTag: item.etag || '',
      },
      updated_at: item.lastModified || null,
    }));
  }

  return {
    enabled: config.enabled,
    primary: config.primary,
    mode: config.mode,
    configured: config.configured,
    bucket: config.bucket,
    putObject,
    getObject,
    removeObjects,
    signedUrl,
    headObject,
    listObjects,
  };
}

let singleton = null;
function getOssStorage() {
  if (!singleton) singleton = createOssStorage();
  return singleton;
}

function ossStorageStatus(env = process.env) {
  const config = readOssStorageConfig(env);
  if (config.enabled) return config.mode;
  if (config.mode !== 'disabled') return 'awaiting-credentials';
  return 'disabled';
}

module.exports = {
  DEFAULT_SIGNED_SECONDS,
  readOssStorageConfig,
  safeMessage,
  toBuffer,
  createOssStorage,
  getOssStorage,
  ossStorageStatus,
};
