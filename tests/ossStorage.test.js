'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  readOssStorageConfig,
  createOssStorage,
  probeOssStorage,
  ossStorageStatus,
  ossStorageHealthStatus,
} = require('../ossStorage');
const {
  HASH_HEADER,
  SOURCE_UPDATED_HEADER,
  parseArgs,
  sha256,
  headerValue,
  listSupabaseObjects,
  migrateOne,
  selectRetainedObjects,
} = require('../scripts/migrateSupabaseStorageToOss');
const { createSignedUrlBridge } = require('../ossStoragePatch');

function enabledConfig(mode = 'primary') {
  return {
    selectedProvider: 'oss',
    requestedMode: mode,
    mode,
    configured: true,
    enabled: true,
    primary: mode === 'primary',
    mirrorToSupabase: false,
    region: 'oss-cn-hangzhou',
    accessKeyId: 'id-secret',
    accessKeySecret: 'key-secret',
    bucket: 'ourhome-private',
    endpoint: '',
  };
}

test('Supabase remains primary even when stale OSS mode and credentials survive', () => {
  assert.equal(readOssStorageConfig({}).enabled, false);
  assert.equal(ossStorageStatus({}), 'disabled');
  assert.equal(ossStorageStatus({ OURHOME_OSS_STORAGE_MODE: 'shadow' }), 'disabled');

  const env = {
    OURHOME_OSS_STORAGE_MODE: 'primary',
    ALIYUN_OSS_REGION: 'oss-cn-hangzhou',
    ALIYUN_OSS_ACCESS_KEY_ID: 'id',
    ALIYUN_OSS_ACCESS_KEY_SECRET: 'secret',
    ALIYUN_OSS_BUCKET: 'bucket',
  };
  assert.equal(readOssStorageConfig(env).selectedProvider, 'supabase');
  assert.equal(readOssStorageConfig(env).requestedMode, 'primary');
  assert.equal(readOssStorageConfig(env).primary, false);
  assert.equal(ossStorageStatus(env), 'disabled');

  env.OURHOME_OBJECT_STORAGE_PRIMARY = 'oss';
  assert.equal(readOssStorageConfig(env).primary, true);
  assert.equal(ossStorageStatus(env), 'primary');
});

test('OSS read-only probe reports readiness without writing an object', async () => {
  let lists = 0;
  const env = {
    OURHOME_OBJECT_STORAGE_PRIMARY: 'oss',
    OURHOME_OSS_STORAGE_MODE: 'shadow',
    ALIYUN_OSS_REGION: 'oss-cn-beijing',
    ALIYUN_OSS_ACCESS_KEY_ID: 'id',
    ALIYUN_OSS_ACCESS_KEY_SECRET: 'secret',
    ALIYUN_OSS_BUCKET: 'bucket',
  };
  const result = await probeOssStorage({
    env,
    storage: {
      async listObjects(options) {
        lists += 1;
        assert.deepEqual(options, { limit: 1 });
        return [];
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(lists, 1);
  assert.equal(ossStorageHealthStatus(env), 'shadow-ready');
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

test('signed image reads stay on Supabase until each OSS object exists', async () => {
  const sourceCalls = [];
  const bridge = createSignedUrlBridge({
    oss: {
      async headObject(path) { return path === 'ready.jpg' ? { size: 5 } : null; },
      signedUrl(path) { return `https://oss.example/${path}`; },
    },
    async originalSignOne(path) {
      sourceCalls.push(path);
      return { data: { path, signedUrl: `https://supabase.example/${path}` }, error: null };
    },
    async originalSignMany(paths) {
      sourceCalls.push(...paths);
      return {
        data: paths.map(path => ({ path, signedUrl: `https://supabase.example/${path}`, error: null })),
        error: null,
      };
    },
  });

  assert.equal((await bridge.signOne('waiting.jpg', 60)).data.signedUrl, 'https://supabase.example/waiting.jpg');
  assert.equal((await bridge.signOne('ready.jpg', 60)).data.signedUrl, 'https://oss.example/ready.jpg');
  const batch = await bridge.signMany(['ready.jpg', 'waiting.jpg'], 60);
  assert.deepEqual(batch.data.map(item => item.signedUrl), [
    'https://oss.example/ready.jpg',
    'https://supabase.example/waiting.jpg',
  ]);
  assert.deepEqual(sourceCalls, ['waiting.jpg', 'waiting.jpg']);
});

test('OSS probe errors fall back to the Supabase image instead of returning a broken link', async () => {
  const bridge = createSignedUrlBridge({
    oss: {
      async headObject() { throw new Error('temporary OSS probe failure'); },
      signedUrl() { throw new Error('must not sign an unverified target'); },
    },
    async originalSignOne(path) {
      return { data: { path, signedUrl: `https://supabase.example/${path}` }, error: null };
    },
    async originalSignMany(paths) {
      return { data: paths.map(path => ({ path, signedUrl: `https://supabase.example/${path}` })), error: null };
    },
  });
  assert.equal((await bridge.signOne('photo.jpg', 60)).data.signedUrl, 'https://supabase.example/photo.jpg');
});

test('migration CLI is dry-run by default and apply must be explicit', () => {
  assert.deepEqual(parseArgs([]), {
    apply: false,
    includeExpired: false,
    bucket: 'uploads',
    concurrency: 2,
    limit: Infinity,
    batch: Infinity,
    retentionDays: 30,
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

test('migration resumes without downloading an object stamped from the same source version', async () => {
  const bytes = Buffer.from('photo');
  const updatedAt = '2026-08-12T03:04:05.000Z';
  const fileApi = { async download() { throw new Error('verified marker should avoid a second download'); } };
  const result = await migrateOne({
    fileApi,
    oss: {
      async headObject() {
        return {
          size: bytes.length,
          headers: {
            [HASH_HEADER]: sha256(bytes),
            [SOURCE_UPDATED_HEADER]: updatedAt,
          },
        };
      },
    },
    source: { path: 'a.jpg', size: bytes.length, contentType: 'image/jpeg', updatedAt },
    apply: true,
  });
  assert.equal(result.action, 'verified-marker');
});

test('retained migration skips only expired ordinary images with saved analyses', async () => {
  const base = 'https://demo.supabase.co/storage/v1/object/public/uploads/';
  const rows = [{
    id: 1,
    created_at: '2026-06-01T00:00:00.000Z',
    attachment_url: `${base}expired.jpg`,
    attachment_type: 'image/jpeg',
    attachment_name: 'expired.jpg',
    attachment_summary: '已经确认的画面描述',
  }];
  const supabase = {
    from(table) {
      if (table === 'messages') return { select() { return { async not() { return { data: rows, error: null }; } }; } };
      return { async select() { return { data: [], error: null }; } };
    },
  };
  const inventory = [
    { path: 'expired.jpg', size: 10 },
    { path: 'album.jpg', size: 20 },
  ];
  const selection = await selectRetainedObjects(supabase, inventory, {
    retentionDays: 30,
    now: new Date('2026-08-12T00:00:00.000Z'),
  });
  assert.deepEqual(selection.selected.map(item => item.path), ['album.jpg']);
  assert.deepEqual(selection.expired.map(item => item.path), ['expired.jpg']);
});

test('runtime uses Supabase only and never boots or probes the OSS adapter', () => {
  const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'runtimeBootstrap.js'), 'utf8');
  const render = fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8');
  assert.doesNotMatch(bootstrap, /require\('\.\/ossStoragePatch'\)/);
  assert.doesNotMatch(bootstrap, /probeOssStorage/);
  assert.doesNotMatch(bootstrap, /ossBackfillPatch/);
  assert.match(bootstrap, /object_storage: 'supabase-pro-primary-v1'/);
  assert.match(bootstrap, /object_storage_migration: 'aliyun-retired-source-retained-v1'/);
  assert.match(bootstrap, /image_pipeline: 'sharp-0\.35\.3-libvips-8\.18\.3-v1'/);
  assert.match(bootstrap, /frontend_bundle: 'chat-theater-shared-rule-scopes-v4'/);
  assert.doesNotMatch(bootstrap, /ALIYUN_OSS_ACCESS_KEY_SECRET/);
  assert.match(render, /OURHOME_OBJECT_STORAGE_PRIMARY\s*\n\s*value: supabase/);
  assert.match(render, /OURHOME_OSS_STORAGE_MODE\s*\n\s*value: disabled/);
  assert.doesNotMatch(render, /ALIYUN_OSS_ACCESS_KEY/);
});

test('hash header lookup is case-insensitive', () => {
  assert.equal(headerValue({ 'X-Oss-Meta-Ourhome-Sha256': 'abc' }, HASH_HEADER), 'abc');
});
