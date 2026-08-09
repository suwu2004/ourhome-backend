const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectUploadPaths,
  buildCleanupPlan,
  isImageMessage,
  uploadPath,
} = require('../photoRetention');

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
  assert.deepEqual(plan, [{ path: 'food.jpg', messageIds: [1] }]);
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
