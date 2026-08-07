'use strict';

// Render currently starts the service with `node server.js`. Keep every runtime
// compatibility layer on this one path so local npm start and Render behave the same.
require('./theaterMemoryPatch');
require('./memoryLayerPatch');
require('./modelTokenLimitPatch');
require('./thinkingTransportPatch');
// Keep intimacy last: it becomes the outer transport boundary and sanitizes any
// hidden control after normal text/thinking processing but before server persistence.
require('./intimacyFlowPatch');

console.log('[runtime:bootstrap] theater memory, memory, token, thinking and intimacy patches loaded');

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
