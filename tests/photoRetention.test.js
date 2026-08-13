const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectUploadPaths,
  buildCleanupPlan,
  isImageMessage,
  uploadPath,
  runPhotoRetentionCleanup,
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
    { id: 1, created_at: old, attachment_url: `${base}food.jpg`, attachment_type: 'image/jpeg', attachment_summary: '一盘食物' },
    { id: 2, created_at: old, attachment_url: `${base}album.jpg`, attachment_type: 'image/jpeg', attachment_summary: '纪念照片' },
    { id: 3, created_at: fresh, attachment_url: `${base}recent.jpg`, attachment_type: 'image/jpeg', attachment_summary: '今天的照片' },
    { id: 4, created_at: old, attachment_url: `${base}document.pdf`, attachment_type: 'application/pdf', attachment_summary: '文档' },
  ];
  const plan = buildCleanupPlan({ messages, protectedPaths: new Set(['album.jpg']), cutoffMs });
  assert.deepEqual(plan, [{ path: 'food.jpg', messageIds: [1], contentType: 'image/jpeg', bytes: 0 }]);
});

test('shared object stays when any message reference is newer than the cutoff', () => {
  const messages = [
    { id: 1, created_at: old, attachment_url: `${base}shared.jpg`, attachment_type: 'image/jpeg', attachment_summary: '共享图片' },
    { id: 2, created_at: fresh, attachment_url: `${base}shared.jpg`, attachment_type: 'image/jpeg', attachment_summary: '共享图片' },
  ];
  assert.deepEqual(buildCleanupPlan({ messages, protectedPaths: new Set(), cutoffMs }), []);
});

test('removed markers and non-image files never become cleanup candidates again', () => {
  assert.equal(isImageMessage({ attachment_type: 'image/removed', attachment_url: '' }), false);
  assert.equal(isImageMessage({ attachment_type: 'application/pdf', attachment_url: `${base}a.pdf` }), false);
  assert.equal(isImageMessage({ attachment_type: null, attachment_url: `${base}meal.webp` }), true);
  assert.equal(uploadPath(`${base}folder/%E7%8C%AB.jpg?token=x`), 'folder/猫.jpg');
});

test('old image without a durable analysis is retained', () => {
  const messages = [{ id: 8, created_at: old, attachment_url: `${base}unknown.jpg`, attachment_type: 'image/jpeg', attachment_summary: '' }];
  assert.deepEqual(buildCleanupPlan({ messages, protectedPaths: new Set(), cutoffMs }), []);
});

test('monthly maintenance deletes both byte copies and keeps the image analysis', async () => {
  const messages = [{
    id: 9,
    created_at: old,
    attachment_url: `${base}kept.jpg`,
    attachment_type: 'image/jpeg',
    attachment_name: 'kept.jpg',
    attachment_summary: '画面里是一只趴在窗边的白猫',
  }];
  const removed = [];
  let messageUpdate = null;
  const storage = {
    async list() { return { data: [{ name: 'kept.jpg', metadata: { size: 1234 } }], error: null }; },
    async remove(paths) { removed.push(['oss', ...paths]); return { data: [], error: null }; },
  };
  const sourceStorage = {
    async remove(paths) { removed.push(['supabase', ...paths]); return { data: [], error: null }; },
  };
  const supabase = {
    storage: { from(bucket) { assert.equal(bucket, 'uploads'); return storage; } },
    from(table) {
      if (table === 'messages') {
        return {
          select() { return { async not() { return { data: messages, error: null }; } }; },
          update(payload) {
            return {
              async in(column, ids) {
                messageUpdate = { payload, column, ids };
                return { error: null };
              },
            };
          },
        };
      }
      return { async select() { return { data: [], error: null }; } };
    },
  };
  const result = await runPhotoRetentionCleanup({
    supabase,
    sourceStorage,
    now: new Date('2026-08-11T00:00:00.000Z'),
    retentionDays: 30,
    batchSize: 1,
  });
  assert.equal(result.deletedObjects, 1);
  assert.equal(result.releasedBytes, 1234);
  assert.deepEqual(removed, [['supabase', 'kept.jpg'], ['oss', 'kept.jpg']]);
  assert.deepEqual(messageUpdate, {
    payload: { attachment_url: null, attachment_type: 'image/removed' },
    column: 'id',
    ids: [9],
  });
  assert.equal(messages[0].attachment_summary, '画面里是一只趴在窗边的白猫');
});

test('quota failures and full batches receive a bounded maintenance retry', () => {
  assert.match(photoRetentionSource, /retryDelayMs = 15 \* 60 \* 1000/);
  assert.match(photoRetentionSource, /if \(result\.candidates >= batchSize\) scheduleRetry\(\)/);
  assert.match(photoRetentionSource, /catch \(error\)[\s\S]*scheduleRetry\(\)/);
  assert.match(photoRetentionSource, /Math\.max\(5 \* 60 \* 1000, retryDelayMs\)/);
});
