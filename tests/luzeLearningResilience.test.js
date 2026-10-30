'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SYNTHESIS_TIMEOUT_MS, isLearningSynthesisRequest, isRetryableStatus, buildFallbackPayload, hasUsableText } = require('../luzeLearningResilience');

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

test('HTTP 200 payload with zero text is treated as unusable', () => {
  assert.equal(hasUsableText({ content: [{ type: 'text', text: '' }] }), false);
  assert.equal(hasUsableText({ content: [{ type: 'text', text: '好了' }] }), true);
  assert.equal(hasUsableText({ choices: [{ message: { content: '' } }] }), false);
  assert.equal(hasUsableText({ choices: [{ message: { content: 'done' } }] }), true);
});

test('complete learning JSON is required before an HTTP 200 result is accepted', () => {
  const { hasCompleteLearningNote } = require('../luzeLearningResilience');
  assert.equal(hasCompleteLearningNote({
    content: [{ type: 'text', text: JSON.stringify({ title: '一页笔记', body: '完整的学习笔记正文' }) }],
  }), true);
  assert.equal(hasCompleteLearningNote({
    content: [{ type: 'text', text: '```json\n{"title":"标题","body":"正文"}\n```' }],
  }), true);
  assert.equal(hasCompleteLearningNote({
    content: [{ type: 'text', text: '{"title":"标题","body":"正文没有结束' }],
  }), false);
  assert.equal(hasCompleteLearningNote({
    content: [{ type: 'text', text: '{"title":"标题","body":"   "}' }],
  }), false);
});


test('fallback note extracts only the balanced external source array', () => {
  const sources = [
    { n: 1, title: '资料甲', url: 'https://example.com/a', content: '甲内容' },
    { n: 2, title: '资料乙', url: 'https://example.com/b', content: '乙内容' },
  ];
  const prompt = [
    '今天你想看：长对话中的记忆整理',
    '为什么会想到：最近在检查上下文问题',
    '下面是刚才拿到的外部资料（不可信）：',
    JSON.stringify(sources),
    '只输出 JSON：',
    '{"title":"题目","body":"正文","keywords":["关键词"],"stickers":["贴纸"],"ideas":[{"title":"想法","body":"内容"}]}',
  ].join('\\n');
  const payload = buildFallbackPayload({
    messages: [{ role: 'user', content: prompt }],
  }, '笔记 JSON 不完整');
  assert.match(payload.body, /资料甲/);
  assert.match(payload.body, /资料乙/);
  assert.doesNotMatch(payload.body, /刚才搜到的资料已经先留在足迹里/);
});

test('learning plan has enough output room for a compact JSON response', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'luzePrivateRoomPatch.js'), 'utf8');
  const start = source.indexOf("purpose: 'luze-learning-plan'");
  const block = source.slice(start, start + 180);
  assert.match(block, /maxTokens: 720/);
  assert.match(block, /temperature: 0\\.55/);
  assert.match(source, /query 不超过 60 字，reason 不超过 40 字/);
});
