'use strict';

const express = require('express');

const FRONTEND_ORIGIN = String(process.env.OURHOME_FRONTEND_ORIGIN || 'https://ourhome-frontend.vercel.app').replace(/\/+$/, '');
const FRONTDOOR_PATH = '/home';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PROXY_REQUEST_BYTES = 16 * 1024 * 1024;
const STATIC_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const STATIC_CACHE_STALE_MS = 24 * 60 * 60 * 1000;

const staticCache = new Map();
let staticCacheBytes = 0;

function cacheTtl(pathname) {
  if (pathname === '/') return 60 * 1000;
  if (pathname.startsWith('/assets/')) return 6 * 60 * 60 * 1000;
  return 30 * 60 * 1000;
}

function rememberStatic(pathname, response, body) {
  if (!Buffer.isBuffer(body) || body.length > STATIC_CACHE_MAX_BYTES / 2) return;
  const previous = staticCache.get(pathname);
  if (previous) staticCacheBytes -= previous.body.length;
  staticCache.delete(pathname);
  staticCache.set(pathname, {
    body,
    status: response.status,
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    cacheControl: response.headers.get('cache-control') || '',
    etag: response.headers.get('etag') || '',
    lastModified: response.headers.get('last-modified') || '',
    savedAt: Date.now(),
  });
  staticCacheBytes += body.length;
  while (staticCacheBytes > STATIC_CACHE_MAX_BYTES && staticCache.size > 1) {
    const oldestKey = staticCache.keys().next().value;
    const oldest = staticCache.get(oldestKey);
    staticCache.delete(oldestKey);
    staticCacheBytes -= oldest?.body?.length || 0;
  }
}

function cachedStatic(pathname, { allowStale = false } = {}) {
  const item = staticCache.get(pathname);
  if (!item) return null;
  const age = Date.now() - item.savedAt;
  const limit = allowStale ? STATIC_CACHE_STALE_MS : cacheTtl(pathname);
  if (age > limit) return null;
  return item;
}

function sendCached(res, item) {
  res.status(item.status || 200);
  res.setHeader('Content-Type', item.contentType);
  if (item.cacheControl) res.setHeader('Cache-Control', item.cacheControl);
  if (item.etag) res.setHeader('ETag', item.etag);
  if (item.lastModified) res.setHeader('Last-Modified', item.lastModified);
  res.setHeader('X-OurHome-Frontdoor-Cache', 'render-memory');
  res.send(item.body);
}

async function fetchFrontend(pathname) {
  const fresh = cachedStatic(pathname);
  if (fresh) return { cached: fresh };

  try {
    const response = await fetch(`${FRONTEND_ORIGIN}${pathname}`, {
      method: 'GET',
      headers: {
        Accept: pathname === '/' ? 'text/html,application/xhtml+xml' : '*/*',
        'User-Agent': 'OurHome-Render-Frontdoor/1.0',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`frontend origin returned ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    rememberStatic(pathname, response, body);
    return {
      response,
      body,
    };
  } catch (error) {
    const stale = cachedStatic(pathname, { allowStale: true });
    if (stale) return { cached: stale, stale: true };
    throw error;
  }
}

async function serveFrontendPath(req, res, pathname) {
  try {
    const result = await fetchFrontend(pathname);
    if (result.cached) {
      sendCached(res, result.cached);
      if (result.stale) res.setHeader('X-OurHome-Frontdoor-Stale', '1');
      return;
    }

    const { response, body } = result;
    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    const cacheControl = response.headers.get('cache-control');
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);
    const etag = response.headers.get('etag');
    if (etag) res.setHeader('ETag', etag);
    const lastModified = response.headers.get('last-modified');
    if (lastModified) res.setHeader('Last-Modified', lastModified);
    res.setHeader('X-OurHome-Frontdoor', 'render-gateway-v1');
    res.send(body);
  } catch (error) {
    console.warn('[render-frontdoor] frontend fetch failed:', error?.message || error);
    res.status(502).type('html').send('<!doctype html><meta charset="utf-8"><title>OurHome</title><body style="font-family:sans-serif;padding:32px">OurHome 的备用前门暂时没有取到页面，请稍后刷新。</body>');
  }
}

function forwardedHeaders(req) {
  const headers = {};
  for (const name of ['authorization', 'content-type', 'accept', 'x-ourhome-request-id']) {
    const value = req.headers?.[name];
    if (value) headers[name] = value;
  }
  return headers;
}

async function readProxyBody(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return undefined;

  const contentType = String(req.headers?.['content-type'] || '').toLowerCase();
  if (contentType.includes('application/json') && req.body !== undefined) {
    return Buffer.from(JSON.stringify(req.body));
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_PROXY_REQUEST_BYTES) {
      const error = new Error('proxy request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function localApiUrl(req) {
  const port = Number(process.env.PORT || 3000);
  const original = String(req.originalUrl || req.url || '/api');
  const withoutApi = original.replace(/^\/api(?=\/|\?|$)/, '') || '/';
  const normalized = withoutApi.startsWith('?') ? `/${withoutApi}` : withoutApi;
  return `http://127.0.0.1:${port}${normalized}`;
}

function copyProxyResponseHeaders(response, res) {
  for (const name of ['content-type', 'content-disposition', 'cache-control', 'etag', 'last-modified', 'x-ourhome-request-id']) {
    const value = response.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.setHeader('X-OurHome-Api-Route', 'render-self-proxy-v1');
}

async function proxyApiRequest(req, res, { fetchImpl = fetch } = {}) {
  if (/^\/api\/agentmail\/webhook(?:[/?]|$)/.test(String(req.originalUrl || req.url || ''))) {
    return res.status(404).json({ error: 'not found' });
  }

  try {
    const body = await readProxyBody(req);
    const headers = forwardedHeaders(req);
    delete headers['content-length'];
    const response = await fetchImpl(localApiUrl(req), {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const payload = Buffer.from(await response.arrayBuffer());
    res.status(response.status);
    copyProxyResponseHeaders(response, res);
    return res.send(payload);
  } catch (error) {
    const status = Number(error?.status) || 502;
    console.warn('[render-frontdoor] api proxy failed:', error?.message || error);
    return res.status(status).json({ error: status === 413 ? '请求内容太大' : '备用前门暂时没有接通后端' });
  }
}

function installRenderFrontdoorGateway(app) {
  if (!app || app.__ourhomeRenderFrontdoor) return;

  app.get([FRONTDOOR_PATH, `${FRONTDOOR_PATH}/`], (req, res) => serveFrontendPath(req, res, '/'));
  app.get('/assets/*', (req, res) => serveFrontendPath(req, res, req.originalUrl.split('?')[0]));
  for (const path of ['/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/favicon.ico']) {
    app.get(path, (req, res) => serveFrontendPath(req, res, path));
  }

  // The Vercel service worker is intentionally not installed on the Render origin:
  // it assumes '/' is the app shell, while Render keeps '/' as the backend health endpoint.
  app.get('/ourhome-sw.js', (req, res) => res.status(404).type('text').send('Render front door does not install the Vercel service worker.'));

  app.use('/api', (req, res) => proxyApiRequest(req, res));
  Object.defineProperty(app, '__ourhomeRenderFrontdoor', { value: true, enumerable: false });
  console.log(`[render-frontdoor] fallback UI available at ${FRONTDOOR_PATH}`);
}

const originalListen = express.application.listen;
if (!express.application.__ourhomeRenderFrontdoorListenPatch) {
  express.application.listen = function renderFrontdoorListen(...args) {
    installRenderFrontdoorGateway(this);
    return originalListen.apply(this, args);
  };
  Object.defineProperty(express.application, '__ourhomeRenderFrontdoorListenPatch', { value: true, enumerable: false });
}

module.exports = {
  FRONTDOOR_PATH,
  FRONTEND_ORIGIN,
  localApiUrl,
  readProxyBody,
  proxyApiRequest,
  installRenderFrontdoorGateway,
};
