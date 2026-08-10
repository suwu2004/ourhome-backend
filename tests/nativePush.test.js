'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  FCM_SCOPE,
  createNativePushSender,
  createServiceAccountJwt,
  inferRoute,
  readServiceAccount,
} = require('../nativePush');

function serviceAccountEnv() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    FIREBASE_PROJECT_ID: 'ourhome-test',
    FIREBASE_CLIENT_EMAIL: 'push@ourhome-test.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

test('service account config stays disabled until all required credentials exist', () => {
  assert.equal(readServiceAccount({}), null);
  assert.equal(readServiceAccount({ FIREBASE_PROJECT_ID: 'x' }), null);
  const account = readServiceAccount(serviceAccountEnv());
  assert.equal(account.projectId, 'ourhome-test');
  assert.equal(account.clientEmail, 'push@ourhome-test.iam.gserviceaccount.com');
});

test('service account JWT carries the Firebase Messaging scope', () => {
  const account = readServiceAccount(serviceAccountEnv());
  const jwt = createServiceAccountJwt(account, 1_800_000_000_000);
  const [, payload] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(claims.scope, FCM_SCOPE);
  assert.equal(claims.iss, account.clientEmail);
  assert.equal(claims.aud, account.tokenUri);
  assert.equal(claims.exp - claims.iat, 3600);
});

test('remote push maps OurHome events to rooms', () => {
  assert.equal(inferRoute({ type: 'chat_message' }), 'chat');
  assert.equal(inferRoute({ type: 'schedule_event' }), 'calendar');
  assert.equal(inferRoute({ type: 'agentmail' }), 'settings');
  assert.equal(inferRoute({ route: 'photos', type: 'chat_message' }), 'photos');
  assert.equal(inferRoute({}), 'home');
});

test('FCM sender authenticates once, sends a high-priority data message, and reuses the token', async () => {
  const env = serviceAccountEnv();
  env.FCM_TOPIC = 'ourhome-owner-test';
  let oauthCalls = 0;
  const messages = [];
  const fetchImpl = async (url, options) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      oauthCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'access-token', expires_in: 3600 }),
      };
    }
    messages.push({ url: String(url), options });
    return { ok: true, status: 200, json: async () => ({ name: 'projects/ourhome-test/messages/1' }) };
  };

  const sender = createNativePushSender({ env, fetchImpl, now: () => 1_800_000_000_000 });
  assert.equal(sender.configured, true);
  const first = await sender.send('陆泽', '过来让我看看。', { type: 'chat_message', session_id: 8 });
  const second = await sender.send('提醒', '记得喝水。', { type: 'schedule_event', schedule_id: 9 });

  assert.equal(oauthCalls, 1);
  assert.equal(first.sent, 1);
  assert.equal(second.sent, 1);
  assert.equal(messages.length, 2);
  const firstBody = JSON.parse(messages[0].options.body);
  assert.equal(firstBody.message.topic, 'ourhome-owner-test');
  assert.equal(firstBody.message.android.priority, 'HIGH');
  assert.equal(firstBody.message.data.title, '陆泽');
  assert.equal(firstBody.message.data.route, 'chat');
  assert.equal(firstBody.message.data.session_id, '8');
  assert.match(messages[0].options.headers.Authorization, /^Bearer /);
});

test('sender is a no-op without Firebase credentials', async () => {
  let called = false;
  const sender = createNativePushSender({ env: {}, fetchImpl: async () => { called = true; } });
  const result = await sender.send('OurHome', 'hello');
  assert.equal(sender.configured, false);
  assert.deepEqual(result, { configured: false, sent: 0, failed: 0, reason: 'missing-firebase-service-account' });
  assert.equal(called, false);
});
