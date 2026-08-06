// Preload support for OurHome layered memory.
// Normal memory reads only see active core / episodic / temporary records.
// A lightweight database consolidation runs after startup and then every six hours.

const { filteredMemoryInput, isMemoryTableRead, requestUrl } = require('./memoryLayers');

const originalFetch = globalThis.fetch;
const CONSOLIDATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function runMemoryConsolidation() {
  const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_KEY || '';
  if (!baseUrl || !key || typeof originalFetch !== 'function') return null;

  const response = await originalFetch(`${baseUrl}/rest/v1/rpc/ourhome_consolidate_memory_layers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: '{}',
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`memory consolidation failed (${response.status}) ${detail}`.trim());
  }

  const result = await response.json().catch(() => ({}));
  console.log('[memory:layers] consolidation complete', JSON.stringify(result));
  return result;
}

if (typeof originalFetch === 'function') {
  globalThis.fetch = async function layeredMemoryFetch(input, init = {}) {
    let nextInput = input;
    try {
      nextInput = filteredMemoryInput(input, init);
      if (nextInput !== input && isMemoryTableRead(input, init)) {
        console.log(`[memory:layers] active read ${requestUrl(nextInput)}`);
      }
    } catch (error) {
      console.warn('[memory:layers] read filter skipped:', error.message);
    }
    return originalFetch(nextInput, init);
  };

  const firstRun = setTimeout(() => {
    runMemoryConsolidation().catch(error => console.warn('[memory:layers]', error.message));
  }, 8_000);
  firstRun.unref?.();

  const interval = setInterval(() => {
    runMemoryConsolidation().catch(error => console.warn('[memory:layers]', error.message));
  }, CONSOLIDATION_INTERVAL_MS);
  interval.unref?.();
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function patchedMemoryHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = {
        ...body,
        memory_layers: 'working-episodic-core-v1',
      };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[memory:layers] health marker unavailable:', error.message);
}

module.exports = {
  CONSOLIDATION_INTERVAL_MS,
  runMemoryConsolidation,
};
