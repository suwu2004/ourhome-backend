const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const runtimeConfigSource = fs.readFileSync(path.join(repoRoot, 'runtimeConfig.js'), 'utf8');
const bootstrapSource = fs.readFileSync(path.join(repoRoot, 'runtimeBootstrap.js'), 'utf8');

const patch = name => `require('./${name}')`;
const index = name => bootstrapSource.indexOf(patch(name));

const activePatches = [
  'chatIdempotencyPatch',
  'supabaseQuotaCircuitPatch',
  'neonFailoverFetchPatch',
  'theaterMemoryFactDedupPatch',
  'memoryLayerPatch',
  'modelTokenLimitPatch',
  'thinkingTransportPatch',
  'apiUsageAuditPatch',
  'nonChatBudgetPatch',
  'backgroundAiCostGuardPatch',
  'modelCallSingleflightPatch',
  'theaterMemoryEconomyPatch',
  'theaterMemoryPatch',
  'theaterRawTurnsPatch',
  'theaterPromptAutonomyPatch',
  'contextLedgerPatch',
  'intimacyFlowAutonomyPatch',
  'chatPromptCleanupPatch',
  'chatToolEconomyPatch',
  'chatHistorySearchResiliencePatch',
  'theaterMessagePagingPatch',
  'theaterBranchActionsPatch',
  'intimacyFlowPatch'
];

test('node server.js 会加载当前运行时的稳定性、费用与上下文补丁', () => {
  assert.match(runtimeConfigSource, /^require\('\.\/runtimeBootstrap'\);/);
  for (const name of activePatches) {
    assert.ok(index(name) >= 0, `missing runtime patch: ${name}`);
  }
  assert.equal(index('theaterContinuityGuardPatch'), -1);
  assert.equal(index('theaterLiveTurnGuardPatch'), -1);
});

test('剧场事实压缩、省钱检查与连续性统一由 raw turns 接管', () => {
  const dedupIndex = index('theaterMemoryFactDedupPatch');
  const economyIndex = index('theaterMemoryEconomyPatch');
  const singleflightIndex = index('modelCallSingleflightPatch');
  const theaterIndex = index('theaterMemoryPatch');
  const rawTurnsIndex = index('theaterRawTurnsPatch');
  assert.ok(dedupIndex >= 0 && economyIndex >= 0 && singleflightIndex >= 0 && theaterIndex >= 0 && rawTurnsIndex >= 0);
  assert.ok(dedupIndex < theaterIndex);
  assert.ok(singleflightIndex < economyIndex);
  assert.ok(economyIndex < theaterIndex);
  assert.ok(theaterIndex < rawTurnsIndex);
  assert.equal(index('theaterContinuityGuardPatch'), -1);
  assert.equal(index('theaterLiveTurnGuardPatch'), -1);
});

test('剧场记忆整理位于审计、省钱守门与模型单飞之后', () => {
  const auditIndex = index('apiUsageAuditPatch');
  const budgetIndex = index('nonChatBudgetPatch');
  const backgroundIndex = index('backgroundAiCostGuardPatch');
  const singleflightIndex = index('modelCallSingleflightPatch');
  const economyIndex = index('theaterMemoryEconomyPatch');
  const theaterIndex = index('theaterMemoryPatch');
  assert.ok(auditIndex >= 0 && auditIndex < budgetIndex);
  assert.ok(budgetIndex < backgroundIndex);
  assert.ok(backgroundIndex < singleflightIndex);
  assert.ok(singleflightIndex < economyIndex);
  assert.ok(economyIndex < theaterIndex);
});

test('运行时补丁顺序保持思考、审计、费用保护、模型单飞、剧场层、账本与 Chat 层边界', () => {
  const ordered = [
    'memoryLayerPatch',
    'modelTokenLimitPatch',
    'thinkingTransportPatch',
    'apiUsageAuditPatch',
    'nonChatBudgetPatch',
    'backgroundAiCostGuardPatch',
    'modelCallSingleflightPatch',
    'theaterMemoryEconomyPatch',
    'theaterMemoryPatch',
    'theaterRawTurnsPatch',
    'theaterPromptAutonomyPatch',
    'contextLedgerPatch',
    'intimacyFlowAutonomyPatch',
    'chatPromptCleanupPatch',
    'chatToolEconomyPatch',
    'chatHistorySearchResiliencePatch',
    'intimacyFlowPatch'
  ].map(index);
  assert.ok(ordered.every(value => value >= 0));
  for (let i = 1; i < ordered.length; i += 1) {
    assert.ok(ordered[i - 1] < ordered[i]);
  }
});

test('direct server start 会保留稳定性补丁的启动顺序', () => {
  const chat = index('chatIdempotencyPatch');
  const circuit = index('supabaseQuotaCircuitPatch');
  const neon = index('neonFailoverFetchPatch');
  const audit = index('apiUsageAuditPatch');
  const budget = index('nonChatBudgetPatch');
  const background = index('backgroundAiCostGuardPatch');
  const singleflight = index('modelCallSingleflightPatch');
  assert.ok(chat >= 0 && chat < circuit && circuit < neon);
  assert.ok(audit >= 0 && audit < budget && budget < background && background < singleflight);
});
