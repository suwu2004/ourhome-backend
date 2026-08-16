const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const thinking = fs.readFileSync(path.resolve(__dirname, '..', 'thinkingTransportPatch.js'), 'utf8');
const audit = fs.readFileSync(path.resolve(__dirname, '..', 'apiUsageAuditPatch.js'), 'utf8');
const bootstrap = fs.readFileSync(path.resolve(__dirname, '..', 'runtimeBootstrap.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));

test('Chat only displays provider-native reasoning and never forces or synthesizes a visible chain', () => {
  assert.doesNotMatch(thinking, /deterministicFallbackThought/);
  assert.doesNotMatch(thinking, /guaranteeVisibleThinking/);
  assert.doesNotMatch(thinking, /appendVisibleThinkingProtocol/);
  assert.match(thinking, /native-only-thinking-v8/);
  assert.doesNotMatch(thinking, /delete body\.thinking/);
  assert.match(thinking, /prepareMainChatRequest/);
  assert.match(thinking, /headers\.delete\('anthropic-beta'\)/);
  assert.match(thinking, /text: '不想'/);
});

test('provider API calls are audited with request IDs, tokens, status, purpose and precise timing', () => {
  assert.match(audit, /x-ourhome-request-id/i);
  assert.match(audit, /X-OurHome-Call-Purpose/);
  assert.match(audit, /purpose/);
  assert.match(audit, /api_profile_name/);
  assert.match(audit, /input_tokens/);
  assert.match(audit, /output_tokens/);
  assert.match(audit, /duration_ms/);
  assert.match(audit, /started_at/);
  assert.match(audit, /finished_at/);
  assert.match(audit, /http_status/);
  assert.match(audit, /\/api-usage\/logs/);
  assert.match(audit, /provider-call-audit-v3-purpose/);
});

test('legacy think-or-not probes are recognized as local zero-cost work', () => {
  assert.match(audit, /isLocalThinkingDecision/);
  assert.match(audit, /只回答一个词/);
  assert.match(audit, /想 或者 不想/);
  assert.match(audit, /if \(isLocalThinkingDecision\(body\)\) return upstreamFetch\(input, init\)/);
});

test('single production entry keeps audit before budget/background guards and post-audit economy wrappers', () => {
  assert.equal(pkg.scripts.start, 'node server.js');
  const auditIndex = bootstrap.indexOf("require('./apiUsageAuditPatch')");
  const budgetIndex = bootstrap.indexOf("require('./nonChatBudgetPatch')");
  const backgroundIndex = bootstrap.indexOf("require('./backgroundAiCostGuardPatch')");
  const economyIndex = bootstrap.indexOf("require('./chatToolEconomyPatch')");
  const historyIndex = bootstrap.indexOf("require('./chatHistorySearchResiliencePatch')");
  assert.ok(auditIndex >= 0 && auditIndex < budgetIndex);
  assert.ok(budgetIndex < backgroundIndex);
  assert.ok(backgroundIndex < economyIndex);
  assert.ok(economyIndex < historyIndex);
});
