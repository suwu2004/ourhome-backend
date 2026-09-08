const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const runtimeConfigSource = fs.readFileSync(path.join(repoRoot, 'runtimeConfig.js'), 'utf8');
const bootstrapSource = fs.readFileSync(path.join(repoRoot, 'runtimeBootstrap.js'), 'utf8');

function indexOfRequire(name) {
  return bootstrapSource.indexOf(`require('./${name}');`);
}

test('node server.js loads the canonical runtime bootstrap and core stability guards', () => {
  assert.match(runtimeConfigSource, /^require\('\.\/runtimeBootstrap'\);/);
  for (const name of [
    'chatIdempotencyPatch', 'supabaseQuotaCircuitPatch', 'neonFailoverFetchPatch',
    'modelTokenLimitPatch', 'thinkingTransportPatch', 'apiUsageAuditPatch',
    'nonChatBudgetPatch', 'backgroundAiCostGuardPatch', 'modelCallSingleflightPatch',
    'chatPromptCleanupPatch', 'chatToolEconomyPatch', 'chatHistorySearchResiliencePatch',
  ]) assert.ok(indexOfRequire(name) >= 0, `missing ${name}`);
});

test('theater runtime keeps economy before memory and uses raw turns as the continuity source', () => {
  const economy = indexOfRequire('theaterMemoryEconomyPatch');
  const memory = indexOfRequire('theaterMemoryPatch');
  const rawTurns = indexOfRequire('theaterRawTurnsPatch');
  const contextWindow = indexOfRequire('theaterContextWindowPatch');
  const paging = indexOfRequire('theaterMessagePagingPatch');
  assert.ok(economy >= 0 && memory > economy);
  assert.ok(rawTurns > memory);
  assert.ok(contextWindow > rawTurns);
  assert.ok(paging > rawTurns);
  assert.doesNotMatch(bootstrapSource, /theaterContinuityGuardPatch/);
  assert.doesNotMatch(bootstrapSource, /theaterLiveTurnGuardPatch/);
});

test('runtime ordering keeps provider guards ahead of feature-specific routes', () => {
  const audit = indexOfRequire('apiUsageAuditPatch');
  const budget = indexOfRequire('nonChatBudgetPatch');
  const background = indexOfRequire('backgroundAiCostGuardPatch');
  const singleflight = indexOfRequire('modelCallSingleflightPatch');
  const token = indexOfRequire('modelTokenLimitPatch');
  const thinking = indexOfRequire('thinkingTransportPatch');
  assert.ok(audit < budget);
  assert.ok(budget < background);
  assert.ok(background < singleflight);
  assert.ok(token < thinking);
  assert.ok(thinking < audit);
});

test('direct startup keeps Chat, Theater, Toybox, Drawing and private-room routes wired', () => {
  for (const name of [
    'theaterRawTurnsPatch', 'theaterBranchActionsPatch', 'toyboxRoutePatch',
    'toyboxSocialRoutePatch', 'toyboxDrawingPersistencePatch', 'drawingRoutePatch',
    'luzePrivateRoomPatch', 'intimacyFlowPatch',
  ]) assert.ok(indexOfRequire(name) >= 0, `missing ${name}`);
  assert.match(bootstrapSource, /Final provider-boundary guard/);
});
