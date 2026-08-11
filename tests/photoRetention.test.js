const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  collectUploadPaths,
  buildCleanupPlan,
  isImageMessage,
  uploadPath,
  runPhotoRetentionOptimization,
} = require('../photoRetention');
const photoRetentionSource = require('node:fs').readFileSync(require.resolve('../photoRetention'), 'utf8');

const base = 'https://demo.supabase.co/storage/v1/object/public/uploads/';
const old = '2026-06-01T00:00:00.000Z';
const fresh = '2026-08-08T00:00:00.000Z';
const cutoffMs = Date.parse('2026-07-10T00:00:00.000Z');

test('collects durable upload references from nested album/settings payloads', () => {
  const paths = collectUploadPaths({
    album: JSON.stringify({ image_url: `${base}album/important.jpg` }),
    nested: [{ avatar: `${base}avatar.png?token=x` }],
  });
  assert.deepEqual([...paths].sort(), ['album/important.jpg', 'avatar.png']);
});

test('only old unprotected image-only objects enter the cleanup plan', () => {
  const messages = [
    { id: 1, created_at: old, attachment_url: `${base}food.jpg`, attachment_type: 'image/jpeg' },
    { id: 2, created_at: old, attachment_url: `${base}album.jpg`, attachment_type: 'image/jpeg' },
    { id: 3, created_at: fresh, attachment_url: `${base}recent.jpg`, attachment_type: 'image/jpeg' },
    { id: 4, created_at: old, attachment_url: `${base}document.pdf`, attachment_type: 'application/pdf' },
  ];
  const plan = buildCleanupPlan({ messages, protectedPaths: new Set(['album.jpg']), cutoffMs });
  assert.deepEqual(plan, [{ path: 'food.jpg', messageIds: [1], contentType: 'image/jpeg', bytes: 0 }]);
});

test('shared object stays when any message reference is newer than the cutoff', () => {
  const messages = [
    { id: 1, created_at: old, attachment_url: `${base}shared.jpg`, attachment_type: 'image/jpeg' },
    { id: 2, created_at: fresh, attachment_url: `${base}shared.jpg`, attachment_type: 'image/jpeg' },
  ];
  assert.deepEqual(buildCleanupPlan({ messages, protectedPaths: new Set(), cutoffMs }), []);
});

test('removed markers and non-image files never become cleanup candidates again', () => {
  assert.equal(isImageMessage({ attachment_type: 'image/removed', attachment_url: '' }), false);
  assert.equal(isImageMessage({ attachment_type: 'application/pdf', attachment_url: `${base}a.pdf` }), false);
  assert.equal(isImageMessage({ attachment_type: null, attachment_url: `${base}meal.webp` }), true);
  assert.equal(uploadPath(`${base}folder/%E7%8C%AB.jpg?token=x`), 'folder/猫.jpg');
});

test('monthly maintenance replaces old photo bytes in place and keeps its chat URL', async () => {
  const width = 1800;
  const height = 1200;
  const pixels = Buffer.allocUnsafe(width * height * 3);
  for (let index = 0; index < pixels.length; index += 3) {
    const pixel = index / 3;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    pixels[index] = (x * 29 + y * 3) % 256;
    pixels[index + 1] = (x * 5 + y * 23) % 256;
    pixels[index + 2] = (x * 17 + y * 13) % 256;
  }
  const original = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
  const messages = [{ id: 9, created_at: old, attachment_url: `${base}kept.jpg`, attachment_type: 'image/jpeg', attachment_name: 'kept.jpg' }];
  let updated = null;
  const storage = {
    async list() { return { data: [{ name: 'kept.jpg', metadata: { size: original.length } }], error: null }; },
    async download(path) { assert.equal(path, 'kept.jpg'); return { data: original, error: null }; },
    async update(path, body, options) { updated = { path, body, options }; return { data: { path }, error: null }; },
  };
  const supabase = {
    storage: { from(bucket) { assert.equal(bucket, 'uploads'); return storage; } },
    from(table) {
      if (table === 'messages') {
        return { select() { return { async not() { return { data: messages, error: null }; } }; } };
      }
      return { async select() { return { data: [], error: null }; } };
    },
  };
  const result = await runPhotoRetentionOptimization({
    supabase,
    now: new Date('2026-08-11T00:00:00.000Z'),
    retentionDays: 30,
    batchSize: 1,
  });
  assert.equal(result.optimizedObjects, 1);
  assert.equal(updated.path, 'kept.jpg');
  assert.equal(updated.options.contentType, 'image/jpeg');
  assert.ok(updated.body.length < original.length);
  assert.equal(messages[0].attachment_url, `${base}kept.jpg`);
});

test('quota failures and full batches receive a bounded maintenance retry', () => {
  assert.match(photoRetentionSource, /retryDelayMs = 15 \* 60 \* 1000/);
  assert.match(photoRetentionSource, /if \(result\.candidates >= batchSize\) scheduleRetry\(\)/);
  assert.match(photoRetentionSource, /catch \(error\)[\s\S]*scheduleRetry\(\)/);
  assert.match(photoRetentionSource, /Math\.max\(5 \* 60 \* 1000, retryDelayMs\)/);
});
