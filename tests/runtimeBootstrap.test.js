const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const runtimeConfigSource = fs.readFileSync(path.join(repoRoot, 'runtimeConfig.js'), 'utf8');
const bootstrapSource = fs.readFileSync(path.join(repoRoot, 'runtimeBootstrap.js'), 'utf8');

test('node server.js 也会加载运行时补丁', () => {
  assert.match(runtimeConfigSource, /^require\('\.\/runtimeBootstrap'\);/);
  assert.match(bootstrapSource, /require\('\.\/memoryLayerPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/modelTokenLimitPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/thinkingTransportPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/contextLedgerPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/intimacyFlowAutonomyPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/intimacyFlowPatch'\);/);
});

test('运行时补丁按记忆、token、思考、账本、自由度、亲密状态顺序加载', () => {
  const memoryIndex = bootstrapSource.indexOf("require('./memoryLayerPatch')");
  const tokenIndex = bootstrapSource.indexOf("require('./modelTokenLimitPatch')");
  const thinkingIndex = bootstrapSource.indexOf("require('./thinkingTransportPatch')");
  const ledgerIndex = bootstrapSource.indexOf("require('./contextLedgerPatch')");
  const autonomyIndex = bootstrapSource.indexOf("require('./intimacyFlowAutonomyPatch')");
  const intimacyIndex = bootstrapSource.indexOf("require('./intimacyFlowPatch')");
  assert.ok(memoryIndex >= 0 && memoryIndex < tokenIndex);
  assert.ok(tokenIndex < thinkingIndex);
  assert.ok(thinkingIndex < ledgerIndex);
  assert.ok(ledgerIndex < autonomyIndex);
  assert.ok(autonomyIndex < intimacyIndex);
});

test('健康接口会暴露 direct server start 标记', () => {
  assert.match(bootstrapSource, /runtime_bootstrap/);
  assert.match(bootstrapSource, /direct-server-start-v1/);
});
