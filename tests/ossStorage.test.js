'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  readOssStorageConfig,
  createOssStorage,
  ossStorageStatus,
} = require('../ossStorage');
const {
  HASH_HEADER,
  parseArgs,
  sha256,
  headerValue,
  listSupabaseObjects,
  migrateOne,
} = require('../scripts/migrateSupabaseStorageToOss');

function enabledConfig(mode = 'primary') {
  return {
    mode,
    configured: true,
    enabled: true,
    primary: mode === 'primary',
    region: 'oss-cn-hangzhou',
    accessKeyId: 'id-secret',
    accessKeySecret: 'key-secret',
    bucket: 'ourhome-private',
    endpoint: '',
  };
}

test('OSS integration defaults to disabled and waits safely for incomplete credentials', () => {
  assert.equal(readOssStorageConfig({}).enabled, false);
  assert.equal(ossStorageStatus({}), 'disabled');
  assert.equal(ossStorageStatus({ OURHOME_OSS_STORAGE_MODE: 'shadow' }), 'awaiting-credentials');

  const env = {
    OURHOME_OSS_STORAGE_MODE: 'primary',
    ALIYUN_OSS_REGION: 'oss-cn-hangzhou',
    ALIYUN_OSS_ACCESS_KEY_ID: 'id',
    ALIYUN_OSS_ACCESS_KEY_SECRET: 'secret',
    ALIYUN_OSS_BUCKET: 'bucket',
  };
  assert.equal(readOssStorageConfig(env).primary, true);
  assert.equal(ossStorageStatus(env), 'primary');
});

test('OSS storage preserves paths, private caching and verification metadata', async () => {
  const calls = [];
  const client = {
    async put(name, bytes, options) { calls.push({ name, bytes, options }); return {}; },
    signatureUrl(name, options) { return `https://signed.example/${name}?expires=${options.expires}`; },
    async head() {
      return { res: { headers: { 'content-length': '5', [HASH_HEADER]: 'abc', 'content-type': 'image/jpeg' } } };
    },
    async get() { return { content: Buffer.from('photo'), res: { headers: { 'content-type': 'image/jpeg' } } }; },
    async deleteMulti() {},
    async list() { return { objects: [{ name: 'chat/饭.jpg', size: 5, type: 'image/jpeg', etag: 'e' }] }; },
  };
  const oss = createOssStorage({ config: enabledConfig(), client });
  const uploaded = await oss.putObject('chat/饭.jpg', new Blob(['photo']), {
    contentType: 'image/jpeg',
    metadata: { [HASH_HEADER]: 'abc' },
  });

  assert.deepEqual(uploaded, { ok: true, key: 'chat/饭.jpg', size: 5 });
  assert.equal(calls[0].name, 'chat/饭.jpg');
  assert.equal(calls[0].options.headers['Cache-Control'], 'private, max-age=2592000');
  assert.equal(calls[0].options.headers[HASH_HEADER], 'abc');
  assert.equal((await oss.headObject('chat/饭.jpg')).size, 5);
  assert.equal((await oss.getObject('chat/饭.jpg')).bytes.toString(), 'photo');
  assert.match(oss.signedUrl('chat/饭.jpg', 120), /expires=120/);
  assert.equal((await oss.listObjects())[0].name, 'chat/饭.jpg');
});

test('migration CLI is dry-run by default and apply must be explicit', () => {
  assert.deepEqual(parseArgs([]), {
    apply: false,
    bucket: 'uploads',
    concurrency: 2,
    limit: Infinity,
  });
  assert.equal(parseArgs(['--apply', '--concurrency', '9', '--limit', '3']).apply, true);
  assert.equal(parseArgs(['--apply', '--concurrency', '9', '--limit', '3']).concurrency, 5);
  assert.equal(parseArgs(['--apply', '--concurrency', '9', '--limit', '3']).limit, 3);
});

test('Supabase inventory walks folders and paginates without inventing paths', async () => {
  const calls = [];
  const fileApi = {
    async list(prefix) {
      calls.push(prefix);
      if (!prefix) return { data: [{ id: null, name: 'chat', metadata: null }, { id: '1', name: 'root.jpg', metadata: { size: 4 } }], error: null };
      return { data: [{ id: '2', name: '饭.jpg', metadata: { size: 5, mimetype: 'image/jpeg' } }], error: null };
    },
  };
  const result = await listSupabaseObjects(fileApi);
  assert.deepEqual(calls, ['', 'chat']);
  assert.deepEqual(result.map(item => item.path), ['root.jpg', 'chat/饭.jpg']);
});

test('migration verifies hash and skips an already-copied target', async () => {
  let writes = 0;
  const bytes = Buffer.from('photo');
  const digest = sha256(bytes);
  const fileApi = { async download() { throw new Error('download should be avoided only after source hash is known'); } };
  const oss = {
    async headObject() { return { size: bytes.length, headers: { [HASH_HEADER]: digest } }; },
  };

  // Source content must still be read once so a stale or forged metadata hash cannot silently pass.
  fileApi.download = async () => ({ data: new Blob([bytes]), error: null });
  const result = await migrateOne({
    fileApi,
    oss: { ...oss, async putObject() { writes += 1; } },
    source: { path: 'a.jpg', size: bytes.length, contentType: 'image/jpeg' },
    apply: true,
  });
  assert.equal(result.action, 'verified');
  assert.equal(writes, 0);
});

test('runtime uses OSS adapter and never exposes its credentials in health metadata', () => {
  const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'runtimeBootstrap.js'), 'utf8');
  const patch = fs.readFileSync(path.join(__dirname, '..', 'ossStoragePatch.js'), 'utf8');
  assert.match(bootstrap, /require\('\.\/ossStoragePatch'\)/);
  assert.match(bootstrap, /object_storage: `aliyun-oss-\$\{ossStorageStatus\(\)\}-v1`/);
  assert.doesNotMatch(bootstrap, /ALIYUN_OSS_ACCESS_KEY_SECRET/);
  assert.match(patch, /const result = await primaryCall\(path, body, options\)/);
  assert.match(patch, /await oss\.putObject\(path, body/);
  assert.match(patch, /queueMirror\(`Supabase \$\{method\}/);
});

test('hash header lookup is case-insensitive', () => {
  assert.equal(headerValue({ 'X-Oss-Meta-Ourhome-Sha256': 'abc' }, HASH_HEADER), 'abc');
});
