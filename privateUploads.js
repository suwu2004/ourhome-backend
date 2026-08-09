const DEFAULT_BUCKET = 'uploads';
const DEFAULT_SIGNED_SECONDS = 24 * 60 * 60;
const DEFAULT_EXPORT_SIGNED_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_OBJECT_CACHE_SECONDS = 30 * 24 * 60 * 60;
const SIGNED_CACHE_SAFETY_MS = 5 * 60 * 1000;
const STORAGE_QUOTA_COOLDOWN_MS = 60 * 1000;
const UPLOAD_URL_RE = /https?:\/\/[^\s"'<>\\]+\/storage\/v1\/object\/(?:public|sign)\/uploads\/[^\s"'<>\\]+/g;

function encodeStoragePath(path) {
  return String(path || '').split('/').map(segment => encodeURIComponent(segment)).join('/');
}

function parseUploadObjectUrl(value, bucket = DEFAULT_BUCKET) {
  if (typeof value !== 'string' || !value.includes('/storage/v1/object/')) return null;
  try {
    const url = new URL(value);
    const prefixes = [
      `/storage/v1/object/public/${bucket}/`,
      `/storage/v1/object/sign/${bucket}/`,
    ];
    const prefix = prefixes.find(item => url.pathname.startsWith(item));
    if (!prefix) return null;
    const encodedPath = url.pathname.slice(prefix.length);
    if (!encodedPath) return null;
    return {
      origin: url.origin,
      path: decodeURIComponent(encodedPath),
    };
  } catch {
    return null;
  }
}

function canonicalUploadUrl(value, bucket = DEFAULT_BUCKET) {
  const parsed = parseUploadObjectUrl(value, bucket);
  if (!parsed) return value;
  return `${parsed.origin}/storage/v1/object/public/${bucket}/${encodeStoragePath(parsed.path)}`;
}

function canonicalizeUploadReferences(value, bucket = DEFAULT_BUCKET, seen = new WeakSet()) {
  if (typeof value === 'string') return canonicalUploadUrl(value, bucket);
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => { value[index] = canonicalizeUploadReferences(item, bucket, seen); });
    return value;
  }
  Object.keys(value).forEach(key => {
    value[key] = canonicalizeUploadReferences(value[key], bucket, seen);
  });
  return value;
}

function createUploadSigner({ supabase, bucket = DEFAULT_BUCKET, expiresIn = DEFAULT_SIGNED_SECONDS }) {
  const cache = new Map();
  const fileApi = supabase.storage.from(bucket);
  let storageUnavailableUntil = 0;

  function storageUnavailable(error) {
    const status = Number(error?.statusCode || error?.status || error?.status_code || 0);
    const message = String(error?.message || error || '');
    return status === 402 || /payment required|quota|exceeded/i.test(message);
  }

  function rememberStorageUnavailable(error) {
    if (!storageUnavailable(error)) return false;
    storageUnavailableUntil = Date.now() + STORAGE_QUOTA_COOLDOWN_MS;
    return true;
  }

  function cached(path, force = false) {
    if (force) return '';
    const item = cache.get(path);
    return item && item.expiresAt > Date.now() + SIGNED_CACHE_SAFETY_MS ? item.url : '';
  }

  function remember(path, url) {
    if (!url) return;
    cache.set(path, {
      url,
      expiresAt: Date.now() + expiresIn * 1000,
    });
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
  }

  async function signOne(path, { force = false } = {}) {
    const existing = cached(path, force);
    if (existing) return existing;
    if (Date.now() < storageUnavailableUntil) return '';
    const { data, error } = await fileApi.createSignedUrl(path, expiresIn);
    rememberStorageUnavailable(error);
    if (error || !data?.signedUrl) return '';
    remember(path, data.signedUrl);
    return data.signedUrl;
  }

  async function signMany(paths, { force = false } = {}) {
    const unique = [...new Set(paths.filter(Boolean))];
    const result = new Map();
    const missing = [];
    unique.forEach(path => {
      const existing = cached(path, force);
      if (existing) result.set(path, existing);
      else missing.push(path);
    });
    if (!missing.length) return result;
    if (Date.now() < storageUnavailableUntil) return result;

    if (typeof fileApi.createSignedUrls === 'function') {
      try {
        const { data, error } = await fileApi.createSignedUrls(missing, expiresIn);
        if (rememberStorageUnavailable(error)) return result;
        if (!error && Array.isArray(data)) {
          data.forEach((item, index) => {
            const path = item?.path || missing[index];
            if (path && item?.signedUrl) {
              remember(path, item.signedUrl);
              result.set(path, item.signedUrl);
            }
          });
        }
      } catch (error) {
        if (rememberStorageUnavailable(error)) return result;
        // 某些旧版 storage-js 没有批量签名，下面逐条补齐。
      }
    }

    await Promise.all(missing.filter(path => !result.has(path)).map(async path => {
      const signedUrl = await signOne(path, { force });
      if (signedUrl) result.set(path, signedUrl);
    }));
    return result;
  }

  async function signText(text, { force = false } = {}) {
    if (typeof text !== 'string' || !text.includes('/storage/v1/object/')) return text;
    const matches = [...new Set(text.match(UPLOAD_URL_RE) || [])];
    if (!matches.length) return text;
    const parsed = matches.map(url => ({ url, parsed: parseUploadObjectUrl(url, bucket) })).filter(item => item.parsed);
    const signed = await signMany(parsed.map(item => item.parsed.path), { force });
    let output = text;
    parsed.forEach(item => {
      const signedUrl = signed.get(item.parsed.path);
      if (signedUrl) output = output.split(item.url).join(signedUrl);
    });
    return output;
  }

  return { signOne, signMany, signText };
}

function installPrivateBucketGuard(supabase, bucket = DEFAULT_BUCKET) {
  const storage = supabase?.storage;
  if (!storage || storage.__ourhomePrivateBucketGuard) return;
  const originalCreate = typeof storage.createBucket === 'function' ? storage.createBucket.bind(storage) : null;
  const originalUpdate = typeof storage.updateBucket === 'function' ? storage.updateBucket.bind(storage) : null;
  const originalFrom = typeof storage.from === 'function' ? storage.from.bind(storage) : null;

  if (originalCreate) {
    storage.createBucket = (id, options = {}) => originalCreate(id, {
      ...options,
      public: id === bucket ? false : options.public,
    });
  }
  if (originalUpdate) {
    storage.updateBucket = (id, options = {}) => originalUpdate(id, {
      ...options,
      public: id === bucket ? false : options.public,
    });
  }
  if (originalFrom) {
    storage.from = id => {
      const fileApi = originalFrom(id);
      if (id !== bucket || !fileApi || fileApi.__ourhomeUploadCacheGuard) return fileApi;
      const originalUpload = typeof fileApi.upload === 'function' ? fileApi.upload.bind(fileApi) : null;
      const originalFileUpdate = typeof fileApi.update === 'function' ? fileApi.update.bind(fileApi) : null;
      const withCache = options => {
        const next = { ...(options || {}) };
        if (next.cacheControl == null) next.cacheControl = String(DEFAULT_OBJECT_CACHE_SECONDS);
        return next;
      };
      if (originalUpload) {
        fileApi.upload = (path, body, options = {}) => originalUpload(path, body, withCache(options));
      }
      if (originalFileUpdate) {
        fileApi.update = (path, body, options = {}) => originalFileUpdate(path, body, withCache(options));
      }
      Object.defineProperty(fileApi, '__ourhomeUploadCacheGuard', { value: true, enumerable: false });
      return fileApi;
    };
  }
  Object.defineProperty(storage, '__ourhomePrivateBucketGuard', {
    value: true,
    enumerable: false,
  });
}

function installSignedUploadFetch({ signer, bucket = DEFAULT_BUCKET }) {
  if (globalThis.__ourhomeSignedUploadFetch || typeof globalThis.fetch !== 'function') return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async function signedUploadFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    const parsed = (method === 'GET' || method === 'HEAD') ? parseUploadObjectUrl(url, bucket) : null;
    if (!parsed) return originalFetch(input, init);

    const signedUrl = await signer.signOne(parsed.path);
    if (!signedUrl) return originalFetch(input, init);
    if (typeof Request !== 'undefined' && input instanceof Request) {
      return originalFetch(new Request(signedUrl, input), init);
    }
    return originalFetch(signedUrl, init);
  };
  globalThis.__ourhomeSignedUploadFetch = true;
}

function requestPath(req) {
  return String(req?.originalUrl || req?.url || req?.path || '').split('?')[0];
}

function createPrivateUploadMiddleware({ signer, exportSigner = signer, bucket = DEFAULT_BUCKET }) {
  return function privateUploadMiddleware(req, res, next) {
    if (req.body && typeof req.body === 'object') canonicalizeUploadReferences(req.body, bucket);

    const path = requestPath(req);
    const keepStableReferences = path === '/backup' || path.startsWith('/backup/');
    const forceRefresh = String(req.headers?.['x-ourhome-refresh-assets'] || '') === '1';
    const responseSigner = path === '/export' || path.startsWith('/export/') ? exportSigner : signer;
    const originalSend = res.send.bind(res);
    let sending = false;
    res.send = function sendWithSignedUploads(body) {
      if (
        sending
        || keepStableReferences
        || res.statusCode >= 400
        || typeof body !== 'string'
        || !body.includes('/storage/v1/object/')
      ) {
        return originalSend(body);
      }
      sending = true;
      responseSigner.signText(body, { force: forceRefresh })
        .then(originalSend)
        .catch(error => {
          console.error('附件临时链接生成失败，继续返回原始引用:', error.message);
          originalSend(body);
        });
      return res;
    };
    return next();
  };
}

function registerPrivateUploadCompatibility(app, {
  supabase,
  bucket = DEFAULT_BUCKET,
  expiresIn = DEFAULT_SIGNED_SECONDS,
  exportExpiresIn = DEFAULT_EXPORT_SIGNED_SECONDS,
  installFetch = true,
} = {}) {
  installPrivateBucketGuard(supabase, bucket);
  const signer = createUploadSigner({ supabase, bucket, expiresIn });
  const exportSigner = createUploadSigner({ supabase, bucket, expiresIn: exportExpiresIn });
  if (installFetch) installSignedUploadFetch({ signer, bucket });
  app.use(createPrivateUploadMiddleware({ signer, exportSigner, bucket }));
  return signer;
}

module.exports = {
  DEFAULT_BUCKET,
  DEFAULT_SIGNED_SECONDS,
  DEFAULT_EXPORT_SIGNED_SECONDS,
  DEFAULT_OBJECT_CACHE_SECONDS,
  parseUploadObjectUrl,
  canonicalUploadUrl,
  canonicalizeUploadReferences,
  createUploadSigner,
  installPrivateBucketGuard,
  installSignedUploadFetch,
  createPrivateUploadMiddleware,
  registerPrivateUploadCompatibility,
};
