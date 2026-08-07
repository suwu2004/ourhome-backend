const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const thinking = fs.readFileSync(path.resolve(__dirname, '..', 'thinkingTransportPatch.js'), 'utf8');
const audit = fs.readFileSync(path.resolve(__dirname, '..', 'apiUsageAuditPatch.js'), 'utf8');
const pkg = fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8');

test('visible-thinking fallback never makes a second paid provider request', () => {
  assert.doesNotMatch(thinking, /buildFallbackRequestBody/);
  assert.doesNotMatch(thinking, /fallbackResponse\s*=\s*await\s+originalFetch/);
  assert.match(thinking, /deterministicFallbackThought\(mainBody\.messages\)/);
  assert.match(thinking, /guaranteed-visible-thinking-v6-local-fallback/);
});

test('provider API calls are audited with request IDs, tokens, status and timing', () => {
  assert.match(audit, /x-ourhome-request-id/i);
  assert.match(audit, /api_profile_name/);
  assert.match(audit, /input_tokens/);
  assert.match(audit, /output_tokens/);
  assert.match(audit, /duration_ms/);
  assert.match(audit, /http_status/);
  assert.match(audit, /\/api-usage\/logs/);
});

test('audit patch loads after thinking transport so it sees final provider calls', () => {
  assert.match(pkg, /thinkingTransportPatch\.js -r \.\/apiUsageAuditPatch\.js server\.js/);
});
