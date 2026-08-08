'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  LEARNING_PLAN_TIMEOUT_MS,
  VISION_READER_TIMEOUT_MS,
  DAILY_WRITING_TIMEOUT_MS,
  TOYBOX_TIMEOUT_MS,
  HEARTBEAT_TIMEOUT_MS,
  timeoutForRequest,
} = require('../runtimeTimeoutGuard');

function modelInit({ purpose = '', system = '', message = 'hello' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (purpose) headers['X-OurHome-Call-Purpose'] = purpose;
  return {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'cheap-test-model',
      system,
      messages: [{ role: 'user', content: message }],
    }),
  };
}

test('Luze learning planning gets one 60-second call window', () => {
  assert.equal(LEARNING_PLAN_TIMEOUT_MS, 60_000);
  assert.equal(timeoutForRequest(modelInit({ purpose: 'luze-learning-plan' })), 60_000);
});

test('vision reader gets a 150-second ceiling without retrying', () => {
  assert.equal(VISION_READER_TIMEOUT_MS, 150_000);
  assert.equal(timeoutForRequest(modelInit({ purpose: 'vision-reader' })), 150_000);
  assert.equal(timeoutForRequest(modelInit({ system: '你是 OurHome 的图片代读器，只描述图片。' })), 150_000);
});

test('daily writing gets a 120-second ceiling using purpose or exact writer prompts', () => {
  assert.equal(DAILY_WRITING_TIMEOUT_MS, 120_000);
  assert.equal(timeoutForRequest(modelInit({ purpose: 'daily-writing' })), 120_000);
  assert.equal(timeoutForRequest(modelInit({ message: '现在已经到了每天收好这一天的时间。请写一篇日记。' })), 120_000);
  assert.equal(timeoutForRequest(modelInit({ message: '这是 2026-08-09 这一天，心情日历里已经写下的内容：今天很好。' })), 120_000);
});

test('Toybox model calls get one 75-second call window', () => {
  assert.equal(TOYBOX_TIMEOUT_MS, 75_000);
  assert.equal(timeoutForRequest(modelInit({ system: '你是陆泽。\n【玩具箱】\n轻量小游戏。' })), 75_000);
});

test('heartbeat proactive message is capped at 75 seconds', () => {
  assert.equal(HEARTBEAT_TIMEOUT_MS, 75_000);
  assert.equal(timeoutForRequest(modelInit({ message: '这不是刚发来的消息，而是自动心跳提醒你：如果确实过了一段时间没说话，可以主动敲门。' })), 75_000);
});

test('ordinary Chat and unrelated requests are not rewritten', () => {
  assert.equal(timeoutForRequest(modelInit({ system: '普通聊天' })), 0);
  assert.equal(timeoutForRequest(modelInit({ message: '幸福日记怎么变了，我想看看。' })), 0);
  assert.equal(timeoutForRequest({ method: 'GET' }), 0);
});

test('runtime timeout patch deliberately contains no retry loop', () => {
  const patch = fs.readFileSync(path.resolve(__dirname, '..', 'runtimeTimeoutGuardPatch.js'), 'utf8');
  assert.doesNotMatch(patch, /retrying|for\s*\([^)]*attempt|while\s*\(/i);
  assert.match(patch, /signal:\s*controller\.signal/);
});
