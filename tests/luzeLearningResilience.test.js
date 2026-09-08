'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SYNTHESIS_TIMEOUT_MS, isLearningSynthesisRequest, isRetryableStatus, buildFallbackPayload } = require('../luzeLearningResilience');

function synthesisInit() {
  const sources = [
    { title: '资料甲', url: 'https://example.com/a', content: '甲内容', source: 'web_search' },
    { title: '资料乙', url: 'https://example.com/b', content: '乙内容', source: 'web_search' },
  ];
  return {
    headers: { 'X-OurHome-Call-Purpose': 'luze-learning-synthesis' },
    body: JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: `今天你想看：雨后泥土气味为什么让人平静\n为什么会想到：刚刚听见雨声。\n\n资料：${JSON.stringify(sources)}\n\n只输出 JSON：\n{"title":"题目","body":"正文"}` }] }),
  };
}

test('learning-note synthesis gets a wider timeout than the old 55s room helper window', () => {
  assert.equal(SYNTHESIS_TIMEOUT_MS, 110_000);
  assert.ok(SYNTHESIS_TIMEOUT_MS > 55_000);
});

test('only Luze learning synthesis uses the resilience path', () => {
  assert.equal(isLearningSynthesisRequest(synthesisInit()), true);
  assert.equal(isLearningSynthesisRequest({ headers: { 'X-OurHome-Call-Purpose': 'luze-learning-plan' } }), false);
  assert.equal(isLearningSynthesisRequest({ headers: { 'X-OurHome-Call-Purpose': 'luze-private-consent' } }), false);
});

test('only clear transient HTTP failures are retried', () => {
  for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(status), true);
  for (const status of [400, 401, 403, 404, 422]) assert.equal(isRetryableStatus(status), false);
});

test('fallback note preserves the learning topic and leaves compact resumable breadcrumbs', () => {
  const payload = buildFallbackPayload(JSON.parse(synthesisInit().body), '整理超时');
  assert.match(payload.title, /雨后泥土气味/);
  assert.match(payload.body, /资料|暂存线索|接着整理/);
  assert.ok(payload.stickers.some(item => /以后|接着|没写完/.test(item)));
});

test('runtime loads learning resilience before the private-room module', () => {
  const runtime = fs.readFileSync(path.resolve(__dirname, '..', 'runtimeBootstrap.js'), 'utf8');
  const resilienceAt = runtime.indexOf("require('./luzeLearningResiliencePatch')");
  const roomAt = runtime.indexOf("require('./luzePrivateRoomPatch')");
  assert.ok(resilienceAt >= 0 && roomAt > resilienceAt);
});
