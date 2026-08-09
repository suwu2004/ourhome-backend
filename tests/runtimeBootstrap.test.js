const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const runtimeConfigSource = fs.readFileSync(path.join(repoRoot, 'runtimeConfig.js'), 'utf8');
const bootstrapSource = fs.readFileSync(path.join(repoRoot, 'runtimeBootstrap.js'), 'utf8');

test('node server.js 也会加载审计与所有费用保护补丁', () => {
  assert.match(runtimeConfigSource, /^require\('\.\/runtimeBootstrap'\);/);
  assert.match(bootstrapSource, /require\('\.\/neonFailoverFetchPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/memoryLayerPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/modelTokenLimitPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/thinkingTransportPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/apiUsageAuditPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/nonChatBudgetPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/backgroundAiCostGuardPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/contextLedgerPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/intimacyFlowAutonomyPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/chatPromptCleanupPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/intimacyFlowPatch'\);/);
});

test('运行时补丁按思考、审计、非 Chat 省钱、本地后台保护、账本顺序加载', () => {
  const memoryIndex = bootstrapSource.indexOf("require('./memoryLayerPatch')");
  const tokenIndex = bootstrapSource.indexOf("require('./modelTokenLimitPatch')");
  const thinkingIndex = bootstrapSource.indexOf("require('./thinkingTransportPatch')");
  const auditIndex = bootstrapSource.indexOf("require('./apiUsageAuditPatch')");
  const budgetIndex = bootstrapSource.indexOf("require('./nonChatBudgetPatch')");
  const backgroundIndex = bootstrapSource.indexOf("require('./backgroundAiCostGuardPatch')");
  const ledgerIndex = bootstrapSource.indexOf("require('./contextLedgerPatch')");
  const autonomyIndex = bootstrapSource.indexOf("require('./intimacyFlowAutonomyPatch')");
  const cleanupIndex = bootstrapSource.indexOf("require('./chatPromptCleanupPatch')");
  const intimacyIndex = bootstrapSource.indexOf("require('./intimacyFlowPatch')");
  assert.ok(memoryIndex >= 0 && memoryIndex < tokenIndex);
  assert.ok(tokenIndex < thinkingIndex);
  assert.ok(thinkingIndex < auditIndex);
  assert.ok(auditIndex < budgetIndex);
  assert.ok(budgetIndex < backgroundIndex);
  assert.ok(backgroundIndex < ledgerIndex);
  assert.ok(ledgerIndex < autonomyIndex);
  assert.ok(autonomyIndex < cleanupIndex);
  assert.ok(cleanupIndex < intimacyIndex);
});

test('健康接口会暴露新版 direct server start 费用保护标记', () => {
  assert.match(bootstrapSource, /runtime_bootstrap/);
  assert.match(bootstrapSource, /direct-server-start-v2-cost-guard/);
});
