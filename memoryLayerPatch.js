// Preload support for OurHome layered memory.
// Normal memory reads only see active core / episodic / temporary records.
// A lightweight database consolidation runs after startup and then every six hours.

const { filteredMemoryInput, isMemoryTableRead, requestUrl } = require('./memoryLayers');

const originalFetch = globalThis.fetch;
const CONSOLIDATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

function requestMethod(input, init = {}) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}

function broadenWorkingMemoryList(input, init = {}) {
  if (requestMethod(input, init) !== 'GET') return input;
  const raw = requestUrl(input);
  if (!raw) return input;
  try {
    const parsed = new URL(raw);
    if (!/\/rest\/v1\/memory_marks$/i.test(parsed.pathname)) return input;
    // This signature is the user-facing /memory-log list. Keep the much smaller
    // should_continue-only query used for Chat prompt injection untouched.
    if (parsed.searchParams.get('select') !== '*') return input;
    if (parsed.searchParams.get('limit') !== '40') return input;
    if (!parsed.searchParams.has('mark_date')) return input;
    if (parsed.searchParams.get('should_continue') !== 'eq.true') return input;
    parsed.searchParams.delete('should_continue');
    const next = parsed.toString();
    if (typeof input === 'string') return next;
    if (input instanceof URL) return new URL(next);
    if (typeof Request !== 'undefined' && input instanceof Request) return new Request(next, input);
  } catch {
    return input;
  }
  return input;
}

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
      nextInput = broadenWorkingMemoryList(nextInput, init);
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
        memory_layers: 'model-owned-working-memory-v2',
      };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[memory:layers] health marker unavailable:', error.message);
}

module.exports = {
  CONSOLIDATION_INTERVAL_MS,
  broadenWorkingMemoryList,
  runMemoryConsolidation,
};
