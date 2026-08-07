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

test('provider API calls are audited with request IDs, tokens, status and precise timing', () => {
  assert.match(audit, /x-ourhome-request-id/i);
  assert.match(audit, /api_profile_name/);
  assert.match(audit, /input_tokens/);
  assert.match(audit, /output_tokens/);
  assert.match(audit, /duration_ms/);
  assert.match(audit, /started_at/);
  assert.match(audit, /finished_at/);
  assert.match(audit, /http_status/);
  assert.match(audit, /\/api-usage\/logs/);
  assert.match(audit, /provider-call-audit-v2/);
});

test('local thinking decision probes are not counted as paid provider calls', () => {
  assert.match(audit, /isLocalThinkingDecision/);
  assert.match(audit, /只回答一个词/);
  assert.match(audit, /想 或者 不想/);
  assert.match(audit, /if \(isLocalThinkingDecision\(body\)\) return upstreamFetch\(input, init\)/);
});

test('audit patch loads after thinking transport so it sees final provider calls', () => {
  assert.match(pkg, /thinkingTransportPatch\.js -r \.\/apiUsageAuditPatch\.js server\.js/);
});
