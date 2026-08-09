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

async function runMiddleware({ path = '/sessions', signer, exportSigner = signer, body = PUBLIC_URL }) {
  const middleware = createPrivateUploadMiddleware({ signer, exportSigner });
  const sent = [];
  const req = { originalUrl: path, body: {} };
  const res = {
    statusCode: 200,
    send(value) { sent.push(value); return this; },
  };
  middleware(req, res, () => res.send(body));
  await new Promise(resolve => setTimeout(resolve, 10));
  return sent[0];
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

test('客户端发现过期图片后可以强制绕过签名缓存', async () => {
  let batch = 0;
  const supabase = {
    storage: {
      from() {
        return {
          async createSignedUrls(paths) {
            batch += 1;
            return { data: paths.map(path => ({ path, signedUrl: `https://signed.example/${path}?token=${batch}` })), error: null };
          },
          async createSignedUrl(path) {
            return { data: { signedUrl: `https://signed.example/${path}?token=${batch}` }, error: null };
          },
        };
      },
    },
  };
  const signer = createUploadSigner({ supabase, expiresIn: 3600 });
  const first = await signer.signText(PUBLIC_URL);
  const cached = await signer.signText(PUBLIC_URL);
  const refreshed = await signer.signText(PUBLIC_URL, { force: true });
  assert.equal(first, cached);
  assert.notEqual(first, refreshed);
  assert.match(refreshed, /token=2/);
});

test('响应中间件会签名读取链接，请求中间件会还原稳定引用', async () => {
  const signer = { signText: async text => text.replace(PUBLIC_URL, 'https://signed.example/temporary') };
  const middleware = createPrivateUploadMiddleware({ signer });
  const sent = [];
  const req = { originalUrl: '/sessions/1/messages', body: { attachment_url: SIGNED_URL } };
  const res = {
    statusCode: 200,
    send(body) { sent.push(body); return this; },
  };

  middleware(req, res, () => res.send(JSON.stringify({ attachment_url: PUBLIC_URL })));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(req.body.attachment_url, PUBLIC_URL);
  assert.equal(JSON.parse(sent[0]).attachment_url, 'https://signed.example/temporary');
});

test('背景恢复请求会把强制刷新标记传给签名器', async () => {
  let received = null;
  const signer = { signText: async (text, options) => { received = options; return text; } };
  const middleware = createPrivateUploadMiddleware({ signer });
  const req = { originalUrl: '/settings', body: {}, headers: { 'x-ourhome-refresh-assets': '1' } };
  const res = { statusCode: 200, send() { return this; } };
  middleware(req, res, () => res.send(PUBLIC_URL));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(received, { force: true });
});

test('备份保持稳定附件引用，不写入即将过期的 token', async () => {
  const signer = { signText: async () => '不该调用' };
  const output = await runMiddleware({ path: '/backup', signer, body: JSON.stringify({ attachment_url: PUBLIC_URL }) });
  assert.equal(JSON.parse(output).attachment_url, PUBLIC_URL);
});

test('HTML 导出使用单独的长效签名器，普通页面仍使用短效签名器', async () => {
  const signer = { signText: async text => text.replace(PUBLIC_URL, 'https://signed.example/short') };
  const exportSigner = { signText: async text => text.replace(PUBLIC_URL, 'https://signed.example/export') };
  const normal = await runMiddleware({ path: '/sessions', signer, exportSigner });
  const exported = await runMiddleware({ path: '/export/session.html', signer, exportSigner });
  assert.equal(normal, 'https://signed.example/short');
  assert.equal(exported, 'https://signed.example/export');
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
