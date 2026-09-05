const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const runtimeConfigSource = fs.readFileSync(path.join(repoRoot, 'runtimeConfig.js'), 'utf8');
const bootstrapSource = fs.readFileSync(path.join(repoRoot, 'runtimeBootstrap.js'), 'utf8');

test('runtime bootstrap loads the shared model boundary and theater continuity layers', () => {
  assert.match(runtimeConfigSource, /^require\('\.\/runtimeBootstrap'\);/);
  assert.match(bootstrapSource, /require\('\.\/modelCallSingleflightPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/theaterMemoryEconomyPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/theaterMemoryPatch'\);/);
  assert.match(bootstrapSource, /require\('\.\/theaterRawTurnsPatch'\);/);
  assert.doesNotMatch(bootstrapSource, /require\('\.\/theaterContinuityGuardPatch'\);/);
  assert.doesNotMatch(bootstrapSource, /require\('\.\/theaterLiveTurnGuardPatch'\);/);
});

test('model singleflight sits after budget protection and before theater memory', () => {
  const index = name => bootstrapSource.indexOf(`require('./${name}')`);
  const background = index('backgroundAiCostGuardPatch');
  const singleflight = index('modelCallSingleflightPatch');
  const economy = index('theaterMemoryEconomyPatch');
  const theater = index('theaterMemoryPatch');
  const rawTurns = index('theaterRawTurnsPatch');
  assert.ok(background >= 0 && singleflight > background);
  assert.ok(economy > singleflight);
  assert.ok(theater > economy);
  assert.ok(rawTurns > theater);
});
