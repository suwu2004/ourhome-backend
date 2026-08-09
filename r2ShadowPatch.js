'use strict';

const privateUploads = require('./privateUploads');
const { getR2ShadowStorage } = require('./r2ShadowStorage');

const originalInstallPrivateBucketGuard = privateUploads.installPrivateBucketGuard;

function queueMirror(label, work) {
  Promise.resolve()
    .then(work)
    .catch(error => {
      const message = String(error?.message || error || 'unknown error')
        .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
        .slice(0, 300);
      console.warn(`[r2-shadow] ${label} skipped:`, message);
    });
}

function installR2ShadowGuard(supabase, bucket = privateUploads.DEFAULT_BUCKET) {
  originalInstallPrivateBucketGuard(supabase, bucket);

  const storage = supabase?.storage;
  if (!storage || storage.__ourhomeR2ShadowGuard || typeof storage.from !== 'function') return;

  const originalFrom = storage.from.bind(storage);
  const shadow = getR2ShadowStorage();

  storage.from = id => {
    const fileApi = originalFrom(id);
    if (id !== bucket || !fileApi || fileApi.__ourhomeR2ShadowGuard) return fileApi;

    const originalUpload = typeof fileApi.upload === 'function' ? fileApi.upload.bind(fileApi) : null;
    const originalUpdate = typeof fileApi.update === 'function' ? fileApi.update.bind(fileApi) : null;
    const originalRemove = typeof fileApi.remove === 'function' ? fileApi.remove.bind(fileApi) : null;

    if (originalUpload) {
      fileApi.upload = async (path, body, options = {}) => {
        const result = await originalUpload(path, body, options);
        if (!result?.error && shadow.enabled) {
          queueMirror(`upload ${path}`, () => shadow.mirrorUpload(path, body, {
            contentType: options?.contentType || body?.type || 'application/octet-stream',
            fileName: String(path || '').split('/').pop() || 'file',
          }));
        }
        return result;
      };
    }

    if (originalUpdate) {
      fileApi.update = async (path, body, options = {}) => {
        const result = await originalUpdate(path, body, options);
        if (!result?.error && shadow.enabled) {
          queueMirror(`update ${path}`, () => shadow.mirrorUpload(path, body, {
            contentType: options?.contentType || body?.type || 'application/octet-stream',
            fileName: String(path || '').split('/').pop() || 'file',
          }));
        }
        return result;
      };
    }

    if (originalRemove) {
      fileApi.remove = async paths => {
        const result = await originalRemove(paths);
        if (!result?.error && shadow.enabled) {
          queueMirror('delete objects', () => shadow.mirrorRemove(paths));
        }
        return result;
      };
    }

    Object.defineProperty(fileApi, '__ourhomeR2ShadowGuard', { value: true, enumerable: false });
    return fileApi;
  };

  Object.defineProperty(storage, '__ourhomeR2ShadowGuard', { value: true, enumerable: false });
}

privateUploads.installPrivateBucketGuard = installR2ShadowGuard;

module.exports = {
  installR2ShadowGuard,
};
