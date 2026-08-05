const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseUploadObjectUrl,
  canonicalUploadUrl,
  canonicalizeUploadReferences,
  createUploadSigner,
  installPrivateBucketGuard,
  createPrivateUploadMiddleware,
} = require('../privateUploads');

const PUBLIC_URL = 'https://demo.supabase.co/storage/v1/object/public/uploads/folder/%E8%80%81%E5%A9%86.png';
const SIGNED_URL = 'https://demo.supabase.co/storage/v1/object/sign/uploads/folder/%E8%80%81%E5%A9%86.png?token=old';

function fakeSupabase() {
  return {
    storage: {
      from(bucket) {
        return {
          async createSignedUrl(path) {
            return { data: { signedUrl: `https://signed.example/${bucket}/${encodeURIComponent(path)}?token=one` }, error: null };
          },
          async createSignedUrls(paths) {
            return {
              data: paths.map(path => ({ path, signedUrl: `https://signed.example/${bucket}/${encodeURIComponent(path)}?token=batch` })),
              error: null,
            };
          },
        };
      },
    },
  };
}

test('公开和旧签名链接都能恢复为同一个稳定附件路径', () => {
  assert.equal(parseUploadObjectUrl(PUBLIC_URL).path, 'folder/老婆.png');
  assert.equal(parseUploadObjectUrl(SIGNED_URL).path, 'folder/老婆.png');
  assert.equal(canonicalUploadUrl(SIGNED_URL), PUBLIC_URL);
});

test('写回数据库前会递归移除短期 token，但不改普通网址', () => {
  const body = {
    attachment_url: SIGNED_URL,
    nested: [{ avatar: SIGNED_URL }, { website: 'https://example.com/a.png' }],
  };
  canonicalizeUploadReferences(body);
  assert.equal(body.attachment_url, PUBLIC_URL);
  assert.equal(body.nested[0].avatar, PUBLIC_URL);
  assert.equal(body.nested[1].website, 'https://example.com/a.png');
});

test('同一份响应里的历史附件会批量换成短期签名链接', async () => {
  const signer = createUploadSigner({ supabase: fakeSupabase(), expiresIn: 3600 });
  const text = JSON.stringify({ first: PUBLIC_URL, second: PUBLIC_URL });
  const signed = await signer.signText(text);
  assert.doesNotMatch(signed, /object\/public\/uploads/);
  assert.match(signed, /token=batch/);
});

test('响应中间件会签名读取链接，请求中间件会还原稳定引用', async () => {
  const signer = { signText: async text => text.replace(PUBLIC_URL, 'https://signed.example/temporary') };
  const middleware = createPrivateUploadMiddleware({ signer });
  const sent = [];
  const req = { body: { attachment_url: SIGNED_URL } };
  const res = {
    statusCode: 200,
    send(body) { sent.push(body); return this; },
  };

  middleware(req, res, () => res.send(JSON.stringify({ attachment_url: PUBLIC_URL })));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(req.body.attachment_url, PUBLIC_URL);
  assert.equal(JSON.parse(sent[0]).attachment_url, 'https://signed.example/temporary');
});

test('旧上传初始化逻辑即使请求 public=true，也会被强制保持私有', async () => {
  const calls = [];
  const supabase = {
    storage: {
      async createBucket(id, options) { calls.push(['create', id, options]); return { data: {}, error: null }; },
      async updateBucket(id, options) { calls.push(['update', id, options]); return { data: {}, error: null }; },
    },
  };
  installPrivateBucketGuard(supabase);
  await supabase.storage.createBucket('uploads', { public: true });
  await supabase.storage.updateBucket('uploads', { public: true });
  assert.equal(calls[0][2].public, false);
  assert.equal(calls[1][2].public, false);
});
