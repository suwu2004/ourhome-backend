'use strict';

const crypto = require('crypto');
const express = require('express');

const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 300;
const originalPost = express.application.post;
const requests = new Map();
let patched = false;

function normalizeRequestId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{8,160}$/.test(id) ? id : '';
}

function compactBody(body = {}) {
  return {
    session_id: body?.session_id == null ? '' : String(body.session_id),
    message: String(body?.message || ''),
    model: String(body?.model || ''),
    attachment_url: String(body?.attachment_url || ''),
    attachment_type: String(body?.attachment_type || ''),
    attachment_name: String(body?.attachment_name || ''),
  };
}

function chatRequestFingerprint(req) {
  const authorization = String(req?.headers?.authorization || '');
  return crypto.createHash('sha256')
    .update(JSON.stringify({ authorization, body: compactBody(req?.body) }))
    .digest('hex');
}

function cacheKey(req, requestId) {
  const authorization = String(req?.headers?.authorization || '');
  const authScope = crypto.createHash('sha256').update(authorization).digest('hex').slice(0, 16);
  return `${authScope}:${requestId}`;
}

function pruneCache(now = Date.now()) {
  for (const [key, entry] of requests.entries()) {
    if (now - entry.createdAt > CACHE_TTL_MS) requests.delete(key);
  }
  while (requests.size > MAX_CACHE_ENTRIES) {
    requests.delete(requests.keys().next().value);
  }
}

function scheduleExpiry(key, entry) {
  const timer = setTimeout(() => {
    if (requests.get(key) === entry) requests.delete(key);
  }, CACHE_TTL_MS);
  timer.unref?.();
}

function cloneBody(value) {
  if (value == null) return value;
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

async function chatIdempotencyMiddleware(req, res, next) {
  const requestId = normalizeRequestId(req.get('X-OurHome-Request-Id'));
  if (!requestId) return next();

  pruneCache();
  const key = cacheKey(req, requestId);
  const fingerprint = chatRequestFingerprint(req);
  const existing = requests.get(key);

  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      return res.status(409).json({
        error: '同一个 Chat 请求编号不能对应不同内容',
        code: 'chat_request_id_conflict',
      });
    }
    try {
      const completed = existing.state === 'done' ? existing.result : await existing.promise;
      res.set('X-OurHome-Idempotent-Replay', '1');
      return res.status(completed.status).json(cloneBody(completed.body));
    } catch (error) {
      return res.status(500).json({
        error: String(error?.message || error || 'Chat 请求没有完成'),
        code: 'chat_request_wait_failed',
      });
    }
  }

  let resolveEntry;
  let rejectEntry;
  const promise = new Promise((resolve, reject) => {
    resolveEntry = resolve;
    rejectEntry = reject;
  });
  // A duplicate waiter may never attach, so prevent Node from reporting an
  // unhandled rejection if the original route terminates unexpectedly.
  promise.catch(() => {});

  const entry = {
    createdAt: Date.now(),
    fingerprint,
    state: 'pending',
    promise,
    result: null,
  };
  requests.set(key, entry);
  scheduleExpiry(key, entry);

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (entry.state === 'pending') {
      const result = { status: res.statusCode || 200, body: cloneBody(body) };
      entry.state = 'done';
      entry.result = result;
      resolveEntry(result);
    }
    return originalJson(body);
  };

  res.once('error', error => {
    if (entry.state === 'pending') {
      entry.state = 'failed';
      rejectEntry(error);
    }
  });

  return next();
}

function patchExpressChatPost() {
  if (patched) return;
  patched = true;
  express.application.post = function patchedPost(path, ...handlers) {
    if (path === '/chat') {
      return originalPost.call(this, path, chatIdempotencyMiddleware, ...handlers);
    }
    return originalPost.call(this, path, ...handlers);
  };
}

patchExpressChatPost();

module.exports = {
  CACHE_TTL_MS,
  chatRequestFingerprint,
  normalizeRequestId,
  patchExpressChatPost,
};
