const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  imagesEndpoint,
  parseImagePayload,
} = require('../drawingService');
const { DRAWING_ASSISTANT_TOOLS } = require('../drawingAssistant');

const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'drawingService.js'), 'utf8');
const routeSource = fs.readFileSync(path.join(__dirname, '..', 'drawingRoutePatch.js'), 'utf8');
const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'runtimeBootstrap.js'), 'utf8');

test('画室使用独立生图站点和 GPT-magic2 默认模型', () => {
  assert.equal(DEFAULT_BASE_URL, 'https://jixiangai.lol/v1');
  assert.equal(DEFAULT_MODEL, 'GPT-magic2');
  assert.equal(imagesEndpoint(DEFAULT_BASE_URL), 'https://jixiangai.lol/v1/images/generations');
  assert.equal(imagesEndpoint('https://example.com/v1/images/generations'), 'https://example.com/v1/images/generations');
});

test('兼容 OpenAI 风格 url、b64_json 和 data URL 图片返回', () => {
  assert.deepEqual(parseImagePayload({ data: [{ url: 'https://example.com/a.png' }] }), { url: 'https://example.com/a.png' });
  const b64 = Buffer.from('hello').toString('base64');
  assert.equal(parseImagePayload({ data: [{ b64_json: b64 }] }).buffer.toString(), 'hello');
  assert.equal(parseImagePayload({ image: `data:image/png;base64,${b64}` }).buffer.toString(), 'hello');
});

test('生图请求有长超时、请求幂等和私有对象存储，不会自动重试扣费', () => {
  assert.match(serviceSource, /REQUEST_TTL_MS = 10 \* 60 \* 1000/);
  assert.match(serviceSource, /AbortSignal\.timeout\(120_000\)/);
  assert.match(serviceSource, /requests\.has\(key\)/);
  assert.match(serviceSource, /storage\.from\(BUCKET\)\.upload/);
  assert.doesNotMatch(serviceSource, /retry/i);
});

test('画室历史、删除和下载都有受认证的后端路由', () => {
  assert.match(routeSource, /app\.get\('\/drawing\/history'/);
  assert.match(routeSource, /app\.post\('\/drawing\/generate'/);
  assert.match(routeSource, /app\.delete\('\/drawing\/history\/:id'/);
  assert.match(routeSource, /app\.get\('\/drawing\/history\/:id\/download'/);
  assert.match(bootstrap, /require\('\.\/drawingRoutePatch'\)/);
});

test('陆泽能读写画室，但主动想画时工具说明要求先获得叶檀同意', () => {
  const names = DRAWING_ASSISTANT_TOOLS.map(tool => tool.name);
  assert.deepEqual(names, ['read_drawing_room', 'create_drawing', 'delete_drawing']);
  const createTool = DRAWING_ASSISTANT_TOOLS.find(tool => tool.name === 'create_drawing');
  assert.match(createTool.description, /得到同意前绝对不要调用/);
  assert.match(createTool.description, /一次授权默认只生成一张/);
});
