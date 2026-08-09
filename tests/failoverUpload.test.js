'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');

test('uploads fall back to a signed Neon object URL when Supabase Storage fails', () => {
  assert.match(server, /storeFailoverObject\s*\(\s*\{/);
  assert.match(server, /storage:\s*'neon-failover'/);
  assert.match(server, /pending_sync:\s*true/);
  assert.match(server, /app\.get\('\/failover-files\/:objectKey'/);
  assert.match(server, /verifyFailoverObjectSignature/);
});
