'use strict';

// Render currently starts the service with `node server.js`, which bypasses the
// `node -r ...` preload flags from package.json. Loading the patches from a
// module imported by server.js makes both startup paths behave the same.
// Node's module cache prevents double installation when npm start is used.
require('./theaterMemoryPatch');
require('./memoryLayerPatch');
require('./modelTokenLimitPatch');
require('./thinkingTransportPatch');

console.log('[runtime:bootstrap] theater memory, memory, token and thinking patches loaded');

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function runtimeBootstrapJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, runtime_bootstrap: 'direct-server-start-v1' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[runtime:bootstrap] health marker unavailable:', error.message);
}
