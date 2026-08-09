const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SIGNED_SECONDS,
  DEFAULT_OBJECT_CACHE_SECONDS,
  installPrivateBucketGuard,
} = require('../privateUploads');

test('normal attachment links stay stable for a day instead of rotating hourly', () => {
  assert.equal(DEFAULT_SIGNED_SECONDS, 24 * 60 * 60);
});

test('new uploads receive long browser cache metadata without changing image bytes', async () => {
  const calls = [];
  const fileApi = {
    async upload(path, body, options) {
      calls.push({ path, body, options });
      return { data: { path }, error: null };
    },
  };
  const supabase = {
    storage: {
      from() { return fileApi; },
    },
  };

  installPrivateBucketGuard(supabase);
  const guarded = supabase.storage.from('uploads');
  const bytes = Buffer.from('same-image-bytes');
  await guarded.upload('meal.jpg', bytes, { contentType: 'image/jpeg' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, bytes);
  assert.equal(calls[0].options.contentType, 'image/jpeg');
  assert.equal(calls[0].options.cacheControl, String(DEFAULT_OBJECT_CACHE_SECONDS));
});

test('explicit cache policy is respected for nonstandard callers', async () => {
  let received;
  const supabase = {
    storage: {
      from() {
        return {
          async upload(path, body, options) { received = options; return { data: {}, error: null }; },
        };
      },
    },
  };
  installPrivateBucketGuard(supabase);
  await supabase.storage.from('uploads').upload('x.jpg', Buffer.from('x'), { cacheControl: '60' });
  assert.equal(received.cacheControl, '60');
});
