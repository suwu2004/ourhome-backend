'use strict';

const DEFAULT_TIMEOUT_MS = 15_000;
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

function clean(value) {
  return String(value || '').trim();
}

function normalizeFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(clean(value).toLowerCase());
}

function readR2ShadowConfig(env = process.env) {
  const accountId = clean(env.CLOUDFLARE_R2_ACCOUNT_ID);
  const apiToken = clean(env.CLOUDFLARE_R2_API_TOKEN);
  const bucket = clean(env.CLOUDFLARE_R2_BUCKET);
  const requested = normalizeFlag(env.OURHOME_R2_SHADOW_ENABLED);
  const configured = Boolean(accountId && apiToken && bucket);
  return {
    requested,
    configured,
    enabled: requested && configured,
    accountId,
    apiToken,
    bucket,
    jurisdiction: clean(env.CLOUDFLARE_R2_JURISDICTION || 'default') || 'default',
  };
}

function encodeObjectKey(path) {
  return String(path || '')
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

function objectEndpoint(config, path) {
  const account = encodeURIComponent(config.accountId);
  const bucket = encodeURIComponent(config.bucket);
  const key = encodeObjectKey(path);
  return `${CLOUDFLARE_API_BASE}/accounts/${account}/r2/buckets/${bucket}/objects/${key}`;
}

function toBlob(body, contentType = 'application/octet-stream') {
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body;
  if (Buffer.isBuffer(body)) return new Blob([body], { type: contentType });
  if (body instanceof ArrayBuffer) return new Blob([body], { type: contentType });
  if (ArrayBuffer.isView(body)) {
    return new Blob([body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)], { type: contentType });
  }
  if (typeof body === 'string') return new Blob([body], { type: contentType });
  return null;
}

function safeMessage(error) {
  const text = String(error?.message || error || 'unknown R2 error');
  return text.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 500);
}

function createR2ShadowStorage({
  config = readR2ShadowConfig(),
  fetchImpl = globalThis.fetch?.bind(globalThis),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('R2 shadow storage requires fetch');

  const baseHeaders = () => ({
    Authorization: `Bearer ${config.apiToken}`,
    ...(config.jurisdiction && config.jurisdiction !== 'default'
      ? { 'cf-r2-jurisdiction': config.jurisdiction }
      : {}),
  });

  async function request(path, init = {}) {
    if (!config.enabled) return { skipped: true, reason: config.requested ? 'not-configured' : 'disabled' };
    const response = await fetchImpl(objectEndpoint(config, path), {
      ...init,
      headers: {
        ...baseHeaders(),
        ...(init.headers || {}),
      },
      signal: init.signal || AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      let detail = '';
      try { detail = String(await response.text()).slice(0, 300); } catch {}
      const error = new Error(`R2 ${init.method || 'GET'} ${response.status}${detail ? `: ${detail}` : ''}`);
      error.status = response.status;
      throw error;
    }
    return response;
  }

  async function mirrorUpload(path, body, { contentType = 'application/octet-stream', fileName = 'file' } = {}) {
    if (!config.enabled) return { skipped: true, reason: config.requested ? 'not-configured' : 'disabled' };
    const blob = toBlob(body, contentType);
    if (!blob) return { skipped: true, reason: 'unsupported-body' };
    const form = new FormData();
    form.append('body', blob, String(fileName || 'file'));
    const response = await request(path, { method: 'PUT', body: form });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (payload && payload.success === false) {
      throw new Error(`R2 upload rejected: ${JSON.stringify(payload.errors || []).slice(0, 300)}`);
    }
    return { ok: true, key: path };
  }

  async function mirrorDelete(path) {
    if (!config.enabled) return { skipped: true, reason: config.requested ? 'not-configured' : 'disabled' };
    await request(path, { method: 'DELETE' });
    return { ok: true, key: path };
  }

  async function mirrorRemove(paths = []) {
    const unique = [...new Set((paths || []).map(item => String(item || '').trim()).filter(Boolean))];
    if (!config.enabled) return { skipped: true, reason: config.requested ? 'not-configured' : 'disabled', deleted: 0 };
    const results = await Promise.allSettled(unique.map(path => mirrorDelete(path)));
    const failures = results
      .map((result, index) => ({ result, path: unique[index] }))
      .filter(item => item.result.status === 'rejected');
    if (failures.length) {
      const error = new Error(`R2 delete failed for ${failures.length}/${unique.length} objects: ${safeMessage(failures[0].result.reason)}`);
      error.failures = failures.map(item => item.path);
      throw error;
    }
    return { ok: true, deleted: unique.length };
  }

  async function getObject(path, { signal } = {}) {
    if (!config.enabled) return { skipped: true, reason: config.requested ? 'not-configured' : 'disabled' };
    return request(path, { method: 'GET', signal });
  }

  return {
    enabled: config.enabled,
    requested: config.requested,
    configured: config.configured,
    bucket: config.bucket,
    mirrorUpload,
    mirrorDelete,
    mirrorRemove,
    getObject,
  };
}

let singleton = null;
function getR2ShadowStorage() {
  if (!singleton) singleton = createR2ShadowStorage();
  return singleton;
}

function r2ShadowStatus(env = process.env) {
  const config = readR2ShadowConfig(env);
  if (config.enabled) return 'enabled';
  if (config.requested) return 'awaiting-credentials';
  return 'disabled';
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  readR2ShadowConfig,
  encodeObjectKey,
  objectEndpoint,
  toBlob,
  createR2ShadowStorage,
  getR2ShadowStorage,
  r2ShadowStatus,
};
