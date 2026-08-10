'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const server = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('native FCM devices register through the authenticated push routes', () => {
  assert.match(server, /app\.post\('\/push\/native\/register'/);
  assert.match(server, /app\.delete\('\/push\/native\/register'/);
  assert.match(server, /`fcm:\$\{token\}`/);
  assert.match(server, /p256dh: 'fcm'/);
});

test('push fanout keeps Web Push and private FCM device rows separate', () => {
  assert.match(server, /endpoint\.startsWith\('fcm:'\)/);
  assert.match(server, /nativePush\.sendToToken\(token, title, body, data\)/);
  assert.doesNotMatch(server, /nativePush\.send\(title, body, data\)/);
  assert.match(server, /Web Push 失败/);
  assert.match(server, /FCM 原生推送失败/);
});
