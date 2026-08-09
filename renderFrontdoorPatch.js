'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const FRONTEND_ORIGIN = String(process.env.OURHOME_FRONTEND_ORIGIN || 'https://ourhome-frontend.vercel.app').replace(/\/+$/, '');
const FRONTDOOR_PATH = '/home';
const LOCAL_FRONTEND_DIR = path.resolve(process.env.OURHOME_RENDER_FRONTEND_DIR || path.join(__dirname, 'render-frontend-dist'));
const FRONTEND_FETCH_TIMEOUT_MS = 15_000;
const API_PROXY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PROXY_REQUEST_BYTES = 16 * 1024 * 1024;
const STATIC_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const STATIC_CACHE_STALE_MS = 24 * 60 * 60 * 1000;
const FRONTDOOR_ICON_PATHS = new Set(['/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']);

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

// Public Render shell requests are intercepted before Express runs its init
// middleware, so `res` is still a native Node ServerResponse here. Keep every
// response on this early path strictly to statusCode/setHeader/end; Express-only
// helpers such as res.status(), res.send() and res.json() are not available yet.
function writePublicResponse(res, statusCode, body, headers = {}) {
  res.statusCode = Number(statusCode) || 200;
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null && value !== '') res.setHeader(name, String(value));
  }
  res.end(body === undefined || body === null ? '' : body);
}

function sendCached(res, item, { stale = false } = {}) {
  const headers = {
    'Content-Type': item.contentType,
    'Cache-Control': item.cacheControl,
    ETag: item.etag,
    'Last-Modified': item.lastModified,
    'X-OurHome-Frontdoor-Cache': 'render-memory',
  };
  if (stale) headers['X-OurHome-Frontdoor-Stale'] = '1';
  writePublicResponse(res, item.status || 200, item.body, headers);
}

function localRelativePath(pathname) {
  if (pathname === '/') return 'index.html';
  if (pathname === '/manifest.json') return 'manifest.json';
  if (FRONTDOOR_ICON_PATHS.has(pathname)) return pathname.slice(1);
  if (pathname.startsWith('/assets/')) return pathname.slice(1);
  return null;
}

function contentTypeFor(pathname) {
  const ext = path.extname(pathname).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  })[ext] || 'application/octet-stream';
}

function localFrontendFile(pathname, rootDir = LOCAL_FRONTEND_DIR) {
  const relative = localRelativePath(pathname);
  if (!relative) return null;
  const root = path.resolve(rootDir);
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  return candidate;
}

async function readLocalFrontend(pathname, { rootDir = LOCAL_FRONTEND_DIR } = {}) {
  const filename = localFrontendFile(pathname, rootDir);
  if (!filename) return null;
  try {
    const body = await fs.promises.readFile(filename);
    return {
      local: true,
      body,
      contentType: contentTypeFor(filename),
      cacheControl: pathname.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

function renderFrontdoorStatus(rootDir = LOCAL_FRONTEND_DIR) {
  return fs.existsSync(path.join(path.resolve(rootDir), 'index.html')) ? 'local-build' : 'remote-fallback';
}

async function fetchFrontend(pathname) {
  const local = await readLocalFrontend(pathname);
  if (local) return local;

  const fresh = cachedStatic(pathname);
  if (fresh) return { cached: fresh };
  try {
    const response = await fetch(`${FRONTEND_ORIGIN}${pathname}`, {
      method: 'GET',
      headers: {
        Accept: pathname === '/' ? 'text/html,application/xhtml+xml' : '*/*',
        'User-Agent': 'OurHome-Render-Frontdoor/2.0',
      },
      signal: AbortSignal.timeout(FRONTEND_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`frontend origin returned ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    rememberStatic(pathname, response, body);
    return { response, body };
  } catch (error) {
    const stale = cachedStatic(pathname, { allowStale: true });
    if (stale) return { cached: stale, stale: true };
    throw error;
  }
}

function resultBody(result) {
  return result.cached?.body || result.body || Buffer.alloc(0);
}

async function serveFrontendPath(req, res, pathname) {
  try {
    const result = await fetchFrontend(pathname);
    if (result.local) {
      return writePublicResponse(res, 200, result.body, {
        'Content-Type': result.contentType,
        'Cache-Control': result.cacheControl,
        'X-OurHome-Frontdoor': 'render-local-build-v3-native-response',
      });
    }
    if (result.cached) {
      sendCached(res, result.cached, { stale: result.stale });
      return;
    }
    const { response, body } = result;
    return writePublicResponse(res, response.status, body, {
      'Content-Type': response.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': response.headers.get('cache-control') || '',
      ETag: response.headers.get('etag') || '',
      'Last-Modified': response.headers.get('last-modified') || '',
      'X-OurHome-Frontdoor': 'render-remote-fallback-v3-native-response',
    });
  } catch (error) {
    console.warn('[render-frontdoor] frontend unavailable:', error?.message || error);
    return writePublicResponse(
      res,
      502,
      '<!doctype html><meta charset="utf-8"><title>OurHome</title><body style="font-family:sans-serif;padding:32px">OurHome 的备用前门暂时没有取到页面，请稍后刷新。</body>',
      { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    );
  }
}

async function serveRenderManifest(req, res) {
  try {
    const result = await fetchFrontend('/manifest.json');
    const manifest = JSON.parse(resultBody(result).toString('utf8'));
    manifest.start_url = FRONTDOOR_PATH;
    manifest.scope = '/';
    return writePublicResponse(res, 200, JSON.stringify(manifest), {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-OurHome-Frontdoor': result.local ? 'render-local-manifest-v3' : 'render-manifest-v3',
    });
  } catch (error) {
    console.warn('[render-frontdoor] manifest unavailable:', error?.message || error);
    return writePublicResponse(res, 404, JSON.stringify({ error: 'manifest unavailable' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }
}

function requestPathname(req) {
  try {
    return new URL(String(req?.url || '/'), 'http://ourhome.local').pathname;
  } catch {
    return '/';
  }
}

function isPublicFrontdoorPath(pathname) {
  return pathname === FRONTDOOR_PATH
    || pathname === `${FRONTDOOR_PATH}/`
    || pathname.startsWith('/assets/')
    || pathname === '/manifest.json'
    || pathname === '/ourhome-sw.js'
    || FRONTDOOR_ICON_PATHS.has(pathname);
}

async function servePublicFrontdoor(req, res, pathname) {
  if (pathname === FRONTDOOR_PATH || pathname === `${FRONTDOOR_PATH}/`) {
    return serveFrontendPath(req, res, '/');
  }
  if (pathname.startsWith('/assets/')) return serveFrontendPath(req, res, pathname);
  if (pathname === '/manifest.json') return serveRenderManifest(req, res);
  if (FRONTDOOR_ICON_PATHS.has(pathname)) return serveFrontendPath(req, res, pathname);
  if (pathname === '/ourhome-sw.js') {
    return writePublicResponse(res, 404, 'Render front door does not install the Vercel service worker.', {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }
  return undefined;
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
    const response = await fetchImpl(localApiUrl(req), {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(API_PROXY_TIMEOUT_MS),
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
  app.use('/api', (req, res) => proxyApiRequest(req, res));
  Object.defineProperty(app, '__ourhomeRenderFrontdoor', { value: true, enumerable: false });
  console.log(`[render-frontdoor] fallback UI available at ${FRONTDOOR_PATH} (${renderFrontdoorStatus()})`);
}

const originalHandle = express.application.handle;
if (!express.application.__ourhomeRenderFrontdoorHandlePatch) {
  express.application.handle = function renderFrontdoorHandle(req, res, out) {
    const pathname = requestPathname(req);
    if (String(req.method || 'GET').toUpperCase() === 'GET' && isPublicFrontdoorPath(pathname)) {
      Promise.resolve(servePublicFrontdoor(req, res, pathname)).catch(error => {
        console.warn('[render-frontdoor] public shell failed:', error?.message || error);
        if (!res.headersSent) {
          writePublicResponse(res, 502, JSON.stringify({ error: '备用前门暂时不可用' }), {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
        } else {
          res.end();
        }
      });
      return;
    }
    return originalHandle.call(this, req, res, out);
  };
  Object.defineProperty(express.application, '__ourhomeRenderFrontdoorHandlePatch', { value: true, enumerable: false });
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
  LOCAL_FRONTEND_DIR,
  API_PROXY_TIMEOUT_MS,
  requestPathname,
  isPublicFrontdoorPath,
  localFrontendFile,
  readLocalFrontend,
  renderFrontdoorStatus,
  writePublicResponse,
  servePublicFrontdoor,
  localApiUrl,
  readProxyBody,
  proxyApiRequest,
  installRenderFrontdoorGateway,
};