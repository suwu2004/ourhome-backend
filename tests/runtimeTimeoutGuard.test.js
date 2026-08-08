'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  LEARNING_PLAN_TIMEOUT_MS,
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

test('Luze learning planning gets one 90-second call window', () => {
  assert.equal(LEARNING_PLAN_TIMEOUT_MS, 90_000);
  assert.equal(timeoutForRequest(modelInit({ purpose: 'luze-learning-plan' })), 90_000);
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
  assert.equal(timeoutForRequest({ method: 'GET' }), 0);
});

test('runtime timeout patch deliberately contains no retry loop', () => {
  const patch = fs.readFileSync(path.resolve(__dirname, '..', 'runtimeTimeoutGuardPatch.js'), 'utf8');
  assert.doesNotMatch(patch, /retrying|for\s*\([^)]*attempt|while\s*\(/i);
  assert.match(patch, /signal:\s*controller\.signal/);
});
