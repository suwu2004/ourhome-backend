const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const runtimeConfigSource = fs.readFileSync(path.join(repoRoot, 'runtimeConfig.js'), 'utf8');
const bootstrapSource = fs.readFileSync(path.join(repoRoot, 'runtimeBootstrap.js'), 'utf8');

test('node server.js 也会加载审计与所有费用保护补丁', () => {
  assert.match(runtimeConfigSource, /^require\('\.\/runtimeBootstrap'\);/);
  assert.match(bootstrapSource, /require\('\.\/chatIdempotencyPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/supabaseQuotaCircuitPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/neonFailoverFetchPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/theaterMemoryFactDedupPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/theaterMemoryEconomyPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/theaterMemoryPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/memoryLayerPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/modelTokenLimitPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/thinkingTransportPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/apiUsageAuditPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/nonChatBudgetPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/backgroundAiCostGuardPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/contextLedgerPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/intimacyFlowAutonomyPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/chatPromptCleanupPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/chatToolEconomyPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/chatHistorySearchResiliencePatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/intimacyFlowPatch'\);/);
});

test('剧场事实压缩和省钱检查都先于剧场记忆主体加载', () => {
  const dedupIndex = bootstrapSource.indexOf("require('./theaterMemoryFactDedupPatch')");
  const economyIndex = bootstrapSource.indexOf("require('./theaterMemoryEconomyPatch')");
  const theaterIndex = bootstrapSource.indexOf("require('./theaterMemoryPatch')");
  assert.ok(dedupIndex >= 0 && economyIndex >= 0 && theaterIndex >= 0);
  assert.ok(dedupIndex < theaterIndex);
  assert.ok(economyIndex < theaterIndex);
});

test('剧场记忆整理在审计和省钱守门之后加载', () => {
  const auditIndex = bootstrapSource.indexOf("require('./apiUsageAuditPatch')");
  const budgetIndex = bootstrapSource.indexOf("require('./nonChatBudgetPatch')");
  const backgroundIndex = bootstrapSource.indexOf("require('./backgroundAiCostGuardPatch')");
  const economyIndex = bootstrapSource.indexOf("require('./theaterMemoryEconomyPatch')");
  const theaterIndex = bootstrapSource.indexOf("require('./theaterMemoryPatch')");
  assert.ok(auditIndex >= 0 && auditIndex < budgetIndex);
  assert.ok(budgetIndex < backgroundIndex);
  assert.ok(backgroundIndex < economyIndex);
  assert.ok(economyIndex < theaterIndex);
  assert.match(bootstrapSource, /background role\/plot memory organizer is captured only after the budget guards/);
});

test('运行时补丁按思考、审计、非 Chat 省钱、本地后台保护、剧场省钱、剧场记忆、账本顺序加载', () => {
  const memoryIndex = bootstrapSource.indexOf("require('./memoryLayerPatch')");
  const tokenIndex = bootstrapSource.indexOf("require('./modelTokenLimitPatch')");
  const thinkingIndex = bootstrapSource.indexOf("require('./thinkingTransportPatch')");
  const auditIndex = bootstrapSource.indexOf("require('./apiUsageAuditPatch')");
  const budgetIndex = bootstrapSource.indexOf("require('./nonChatBudgetPatch')");
  const backgroundIndex = bootstrapSource.indexOf("require('./backgroundAiCostGuardPatch')");
  const theaterEconomyIndex = bootstrapSource.indexOf("require('./theaterMemoryEconomyPatch')");
  const theaterIndex = bootstrapSource.indexOf("require('./theaterMemoryPatch')");
  const ledgerIndex = bootstrapSource.indexOf("require('./contextLedgerPatch')");
  const autonomyIndex = bootstrapSource.indexOf("require('./intimacyFlowAutonomyPatch')");
  const cleanupIndex = bootstrapSource.indexOf("require('./chatPromptCleanupPatch')");
  const economyIndex = bootstrapSource.indexOf("require('./chatToolEconomyPatch')");
  const historyIndex = bootstrapSource.indexOf("require('./chatHistorySearchResiliencePatch')");
  const intimacyIndex = bootstrapSource.indexOf("require('./intimacyFlowPatch')");
  assert.ok(memoryIndex >= 0 && memoryIndex < tokenIndex);
  assert.ok(tokenIndex < thinkingIndex);
  assert.ok(thinkingIndex < auditIndex);
  assert.ok(auditIndex < budgetIndex);
  assert.ok(budgetIndex < backgroundIndex);
  assert.ok(backgroundIndex < theaterEconomyIndex);
  assert.ok(theaterEconomyIndex < theaterIndex);
  assert.ok(theaterIndex < ledgerIndex);
  assert.ok(ledgerIndex < autonomyIndex);
  assert.ok(autonomyIndex < cleanupIndex);
  assert.ok(cleanupIndex < economyIndex);
  assert.ok(economyIndex < historyIndex);
  assert.ok(historyIndex < intimacyIndex);
});

test('direct server start 会加载稳定性保护且顺序与 npm start 对齐', () => {
  const chat = bootstrapSource.indexOf("require('./chatIdempotencyPatch')");
  const circuit = bootstrapSource.indexOf("require('./supabaseQuotaCircuitPatch')");
  const neon = bootstrapSource.indexOf("require('./neonFailoverFetchPatch')");
  assert.ok(chat >= 0 && chat < circuit && circuit < neon);
  assert.match(bootstrapSource, /direct-server-start-v6-theater-memory-economy/);
  assert.match(bootstrapSource, /chat_idempotency: 'request-id-theater-replay-v2'/);
  assert.match(bootstrapSource, /memory_journal: body\.memory_journal \|\| 'model-owned-working-memory-v3-cost-gated'/);
  assert.match(bootstrapSource, /theater_memory: body\.theater_memory \|\| 'anchor-character-plot-state-v3-cheap-refresh'/);
  assert.match(bootstrapSource, /theater_memory_economy: body\.theater_memory_economy \|\| 'six-turn-major-events-v1'/);
  assert.match(bootstrapSource, /happiness_diary: '500-900-char-v1'/);
  assert.match(bootstrapSource, /chat_prompt_cost_control: 'selective-tools-context-budget-v2-memory-one-shot'/);
  assert.match(bootstrapSource, /background_persona: 'purpose-projected-v1'/);
  assert.match(bootstrapSource, /theater_rule_injection: 'live-scoped-library-v1'/);
  assert.match(bootstrapSource, /supabase_quota_circuit: 'rest-402-adaptive-v2'/);
});
