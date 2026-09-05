const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const runtimeConfigSource = fs.readFileSync(path.join(repoRoot, 'runtimeConfig.js'), 'utf8');
const bootstrapSource = fs.readFileSync(path.join(repoRoot, 'runtimeBootstrap.js'), 'utf8');
const patch = name => `require('./${name}')`;
const index = name => bootstrapSource.indexOf(patch(name));

const active = [
  'chatIdempotencyPatch', 'supabaseQuotaCircuitPatch', 'neonFailoverFetchPatch',
  'theaterMemoryFactDedupPatch', 'memoryLayerPatch', 'modelTokenLimitPatch',
  'thinkingTransportPatch', 'apiUsageAuditPatch', 'nonChatBudgetPatch',
  'backgroundAiCostGuardPatch', 'modelCallSingleflightPatch',
  'theaterMemoryEconomyPatch', 'theaterMemoryPatch', 'theaterRawTurnsPatch',
  'theaterPromptAutonomyPatch', 'contextLedgerPatch', 'intimacyFlowAutonomyPatch',
  'chatPromptCleanupPatch', 'chatToolEconomyPatch', 'chatHistorySearchResiliencePatch',
  'intimacyFlowPatch'
];

test('runtime bootstrap loads the active protection and context layers', () => {
  assert.match(runtimeConfigSource, /^require\('\.\/runtimeBootstrap'\);/);
  for (const name of active) assert.ok(index(name) >= 0, `missing patch: ${name}`);
  assert.equal(index('theaterContinuityGuardPatch'), -1);
  assert.equal(index('theaterLiveTurnGuardPatch'), -1);
});

test('runtime bootstrap keeps model-boundary and theater continuity ordering', () => {
  const ordered = [
    'apiUsageAuditPatch', 'nonChatBudgetPatch', 'backgroundAiCostGuardPatch',
    'modelCallSingleflightPatch', 'theaterMemoryEconomyPatch', 'theaterMemoryPatch',
    'theaterRawTurnsPatch', 'theaterPromptAutonomyPatch', 'contextLedgerPatch',
    'chatPromptCleanupPatch', 'chatToolEconomyPatch', 'chatHistorySearchResiliencePatch',
    'intimacyFlowPatch'
  ].map(index);
  assert.ok(ordered.every(value => value >= 0));
  for (let i = 1; i < ordered.length; i += 1) assert.ok(ordered[i - 1] < ordered[i]);
});

test('direct server start keeps required runtime parity markers', () => {
  assert.match(bootstrapSource, /direct-server-start-v8-theater-chat-parity/);
  assert.match(bootstrapSource, /chat_idempotency: 'request-id-theater-replay-v2'/);
  assert.match(bootstrapSource, /memory_journal: body\.memory_journal \|\| 'model-owned-working-memory-v3-cost-gated'/);
  assert.match(bootstrapSource, /theater_memory: body\.theater_memory \|\| 'anchor-character-plot-state-v3-cheap-refresh'/);
  assert.match(bootstrapSource, /theater_memory_economy: body\.theater_memory_economy \|\| 'six-turn-major-events-v1'/);
  assert.match(bootstrapSource, /theater_continuity: body\.theater_continuity \|\| 'live-frontier-no-replay-v1'/);
  assert.match(bootstrapSource, /theater_branch_actions: body\.theater_branch_actions \|\| 'reversible-archive-v1'/);
});
