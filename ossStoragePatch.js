'use strict';

const privateUploads = require('./privateUploads');
const { getOssStorage, safeMessage } = require('./ossStorage');

const originalInstallPrivateBucketGuard = privateUploads.installPrivateBucketGuard;

function queueMirror(label, work) {
  Promise.resolve()
    .then(work)
    .catch(error => console.warn(`[oss-storage] ${label} deferred:`, safeMessage(error)));
}

function storageError(error) {
  const wrapped = new Error(safeMessage(error));
  wrapped.statusCode = Number(error?.status || error?.statusCode || 503);
  return wrapped;
}

async function resolveOssObjects(oss, paths) {
  const unique = [...new Set((paths || []).map(path => String(path || '')).filter(Boolean))];
  const present = new Set();
  await Promise.all(unique.map(async path => {
    try {
      if (await oss.headObject(path)) present.add(path);
    } catch {
      // A target probe must never hide the still-readable Supabase source.
    }
  }));
  return present;
}

function createSignedUrlBridge({ oss, originalSignOne, originalSignMany }) {
  async function signOne(path, expiresIn) {
    const present = await resolveOssObjects(oss, [path]);
    if (!present.has(String(path))) return originalSignOne(path, expiresIn);
    try {
      return { data: { signedUrl: oss.signedUrl(path, expiresIn), path }, error: null };
    } catch (error) {
      console.warn('[oss-storage] signed URL fallback:', safeMessage(error));
      return originalSignOne(path, expiresIn);
    }
  }

  async function signMany(paths, expiresIn) {
    const ordered = (paths || []).map(path => String(path || ''));
    const present = await resolveOssObjects(oss, ordered);
    const missing = ordered.filter(path => path && !present.has(path));
    let fallback = { data: [], error: null };
    if (missing.length) {
      try {
        fallback = await originalSignMany(missing, expiresIn);
      } catch (error) {
        fallback = { data: [], error };
      }
    }
    const fallbackByPath = new Map((fallback?.data || []).map((item, index) => [
      String(item?.path || missing[index] || ''),
      item,
    ]));
    return {
      data: ordered.map(path => {
        if (present.has(path)) {
          return { path, signedUrl: oss.signedUrl(path, expiresIn), error: null };
        }
        return fallbackByPath.get(path) || { path, signedUrl: null, error: fallback?.error || 'source signing failed' };
      }),
      error: fallback?.error || null,
    };
  }

  return { signOne, signMany };
}

function installOssStorageGuard(supabase, bucket = privateUploads.DEFAULT_BUCKET) {
  originalInstallPrivateBucketGuard(supabase, bucket);

  const storage = supabase?.storage;
  if (!storage || storage.__ourhomeOssStorageGuard || typeof storage.from !== 'function') return;
  const oss = getOssStorage();
  const originalFrom = storage.from.bind(storage);

  if (oss.primary) {
    const originalGetBucket = typeof storage.getBucket === 'function' ? storage.getBucket.bind(storage) : null;
    const originalCreateBucket = typeof storage.createBucket === 'function' ? storage.createBucket.bind(storage) : null;
    const originalUpdateBucket = typeof storage.updateBucket === 'function' ? storage.updateBucket.bind(storage) : null;
    storage.getBucket = async id => id === bucket
      ? { data: { id, name: id, public: false }, error: null }
      : originalGetBucket(id);
    storage.createBucket = async (id, options) => id === bucket
      ? { data: { name: id }, error: null }
      : originalCreateBucket(id, options);
    storage.updateBucket = async (id, options) => id === bucket
      ? { data: { message: 'Successfully updated' }, error: null }
      : originalUpdateBucket(id, options);
  }

  storage.from = id => {
    const fileApi = originalFrom(id);
    if (id !== bucket || !fileApi || fileApi.__ourhomeOssStorageGuard) return fileApi;

    const originalUpload = typeof fileApi.upload === 'function' ? fileApi.upload.bind(fileApi) : null;
    const originalUpdate = typeof fileApi.update === 'function' ? fileApi.update.bind(fileApi) : null;
    const originalRemove = typeof fileApi.remove === 'function' ? fileApi.remove.bind(fileApi) : null;
    const originalDownload = typeof fileApi.download === 'function' ? fileApi.download.bind(fileApi) : null;
    const originalList = typeof fileApi.list === 'function' ? fileApi.list.bind(fileApi) : null;
    const originalSignOne = typeof fileApi.createSignedUrl === 'function' ? fileApi.createSignedUrl.bind(fileApi) : null;
    const originalSignMany = typeof fileApi.createSignedUrls === 'function' ? fileApi.createSignedUrls.bind(fileApi) : null;
    const signedUrlBridge = oss.primary && originalSignOne
      ? createSignedUrlBridge({ oss, originalSignOne, originalSignMany })
      : null;

    async function write(method, path, body, options = {}) {
      const primaryCall = method === 'update' ? originalUpdate : originalUpload;
      if (!oss.primary) {
        const result = await primaryCall(path, body, options);
        if (!result?.error && oss.enabled) {
          queueMirror(`${method} ${path}`, () => oss.putObject(path, body, {
            contentType: options?.contentType || body?.type || 'application/octet-stream',
          }));
        }
        return result;
      }
      try {
        await oss.putObject(path, body, {
          contentType: options?.contentType || body?.type || 'application/octet-stream',
        });
        if (primaryCall && oss.mirrorToSupabase) {
          queueMirror(`Supabase ${method} ${path}`, () => primaryCall(path, body, options));
        }
        return { data: { path: String(path), fullPath: `${bucket}/${path}` }, error: null };
      } catch (error) {
        return { data: null, error: storageError(error) };
      }
    }

    if (originalUpload) fileApi.upload = (path, body, options = {}) => write('upload', path, body, options);
    if (originalUpdate) fileApi.update = (path, body, options = {}) => write('update', path, body, options);

    if (originalRemove) {
      fileApi.remove = async paths => {
        if (!oss.primary) {
          const result = await originalRemove(paths);
          if (!result?.error && oss.enabled) queueMirror('remove objects', () => oss.removeObjects(paths));
          return result;
        }
        try {
          await oss.removeObjects(paths);
          if (oss.mirrorToSupabase) queueMirror('Supabase remove objects', () => originalRemove(paths));
          return { data: (paths || []).map(name => ({ name })), error: null };
        } catch (error) {
          return { data: null, error: storageError(error) };
        }
      };
    }

    if (originalSignOne) {
      fileApi.createSignedUrl = (path, expiresIn) => oss.primary
        ? signedUrlBridge.signOne(path, expiresIn)
        : originalSignOne(path, expiresIn);
    }

    if (originalSignMany) {
      fileApi.createSignedUrls = (paths, expiresIn) => oss.primary
        ? signedUrlBridge.signMany(paths, expiresIn)
        : originalSignMany(paths, expiresIn);
    }

    if (originalDownload) {
      fileApi.download = async path => {
        if (!oss.primary) return originalDownload(path);
        try {
          const result = await oss.getObject(path);
          return { data: new Blob([result.bytes], { type: result.contentType }), error: null };
        } catch (error) {
          return originalDownload(path);
        }
      };
    }

    if (originalList) {
      fileApi.list = async (prefix = '', options = {}) => {
        if (!oss.primary) return originalList(prefix, options);
        try {
          const data = await oss.listObjects({ prefix, limit: options.limit, offset: options.offset });
          return { data, error: null };
        } catch (error) {
          return { data: null, error: storageError(error) };
        }
      };
    }

    Object.defineProperty(fileApi, '__ourhomeOssStorageGuard', { value: true, enumerable: false });
    return fileApi;
  };

  Object.defineProperty(storage, '__ourhomeOssStorageGuard', { value: true, enumerable: false });
}

privateUploads.installPrivateBucketGuard = installOssStorageGuard;

module.exports = { createSignedUrlBridge, installOssStorageGuard, resolveOssObjects };
