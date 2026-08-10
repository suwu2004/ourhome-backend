'use strict';

const crypto = require('crypto');

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const DEFAULT_TOPIC = 'ourhome-owner';

function clean(value) {
  return String(value || '').trim();
}

function normalizePrivateKey(value) {
  return clean(value).replace(/\\n/g, '\n');
}

function parseServiceAccountJson(value) {
  const raw = clean(value);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readServiceAccount(env = process.env) {
  const parsed = parseServiceAccountJson(env.FIREBASE_SERVICE_ACCOUNT_JSON) || {};
  const account = {
    projectId: clean(env.FIREBASE_PROJECT_ID || parsed.project_id),
    clientEmail: clean(env.FIREBASE_CLIENT_EMAIL || parsed.client_email),
    privateKey: normalizePrivateKey(env.FIREBASE_PRIVATE_KEY || parsed.private_key),
    tokenUri: clean(env.FIREBASE_TOKEN_URI || parsed.token_uri || DEFAULT_TOKEN_URI),
  };
  if (!account.projectId || !account.clientEmail || !account.privateKey || !account.tokenUri) return null;
  return account;
}

function encodeBase64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return buffer.toString('base64url');
}

function createServiceAccountJwt(account, nowMs = Date.now()) {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = encodeBase64Url(JSON.stringify({
    iss: account.clientEmail,
    scope: FCM_SCOPE,
    aud: account.tokenUri,
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.privateKey);
  return `${unsigned}.${encodeBase64Url(signature)}`;
}

function normalizeData(data = {}) {
  const output = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value == null) continue;
    if (typeof value === 'string') output[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') output[key] = String(value);
    else output[key] = JSON.stringify(value);
  }
  return output;
}

function inferRoute(data = {}) {
  const explicit = clean(data.route || data.room);
  if (explicit) return explicit;
  const type = clean(data.type);
  if (type === 'chat_message') return 'chat';
  if (type === 'schedule_event') return 'calendar';
  if (/agentmail|mail/i.test(type)) return 'settings';
  return 'home';
}

function createNativePushSender({ env = process.env, fetchImpl = global.fetch, now = () => Date.now() } = {}) {
  const account = readServiceAccount(env);
  const topic = clean(env.FCM_TOPIC || DEFAULT_TOPIC) || DEFAULT_TOPIC;
  let cachedAccessToken = '';
  let cachedAccessTokenExpiresAt = 0;

  async function getAccessToken() {
    const nowMs = now();
    if (cachedAccessToken && cachedAccessTokenExpiresAt - nowMs > 60_000) return cachedAccessToken;
    if (!account) throw new Error('Firebase service account is not configured');
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

    const assertion = createServiceAccountJwt(account, nowMs);
    const response = await fetchImpl(account.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
      throw new Error(payload.error_description || payload.error || `Firebase OAuth failed (${response.status})`);
    }
    const expiresInSeconds = Number(payload.expires_in || 3600);
    cachedAccessToken = String(payload.access_token);
    cachedAccessTokenExpiresAt = nowMs + Math.max(60, expiresInSeconds) * 1000;
    return cachedAccessToken;
  }

  async function send(title, body, data = {}) {
    if (!account) return { configured: false, sent: 0, failed: 0, reason: 'missing-firebase-service-account' };
    const accessToken = await getAccessToken();
    const messageData = {
      title: clean(title) || 'OurHome',
      body: clean(body),
      route: inferRoute(data),
      ...normalizeData(data),
    };
    const response = await fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            topic,
            data: messageData,
            android: { priority: 'HIGH' },
          },
        }),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.error || `FCM send failed (${response.status})`;
      throw new Error(String(detail));
    }
    return { configured: true, sent: 1, failed: 0, name: payload.name || '', topic };
  }

  return {
    configured: Boolean(account),
    topic,
    send,
  };
}

module.exports = {
  DEFAULT_TOPIC,
  FCM_SCOPE,
  createNativePushSender,
  createServiceAccountJwt,
  inferRoute,
  normalizeData,
  readServiceAccount,
};
