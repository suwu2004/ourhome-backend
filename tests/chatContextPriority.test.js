'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('formal Chat context wrappers inject history before the final turn guard and one final budget', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'runtimeBootstrap.js'), 'utf8');
  const budget = source.indexOf("require('./mainChatPayloadBudgetPatch')");
  const turnGuard = source.indexOf("require('./chatCurrentTurnGuardPatch')");
  const ledger = source.indexOf("require('./contextLedgerPatch')");

  assert.ok(budget >= 0, 'final payload budget must be installed');
  assert.ok(turnGuard > budget, 'current-turn guard must wrap the final budget');
  assert.ok(ledger > turnGuard, 'rolling ledger must wrap the turn guard so the guard is appended last');
  assert.doesNotMatch(source, /require\(['"]\.\/relayContextBudgetPatch['"]\)/);
});
