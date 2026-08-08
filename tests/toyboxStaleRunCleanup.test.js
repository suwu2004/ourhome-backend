'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'toyboxSocialRoutePatch.js'), 'utf8');

test('stale Toybox cleanup waits one hour and only targets ordinary user rounds', () => {
  assert.match(source, /STALE_USER_RUN_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(source, /AUTO_CLEAN_GAMES\s*=\s*\['harmony',\s*'secret'\]/);
  assert.match(source, /\.eq\('status',\s*'active'\)/);
  assert.match(source, /\.eq\('initiator',\s*'user'\)/);
  assert.match(source, /\.lt\('updated_at',\s*cutoff\)/);
});

test('open-run lookup cleans stale rows before returning current games', () => {
  const cleanAt = source.indexOf('await cleanupStaleUserRuns()');
  const readAt = source.indexOf('const runs = await getStore().getOpenRuns(20)');
  assert.ok(cleanAt >= 0 && readAt > cleanAt);
});

test('stale cleanup never targets Gomoku, Drawing or invited runs', () => {
  const listMatch = source.match(/AUTO_CLEAN_GAMES\s*=\s*\[([^\]]+)\]/)?.[1] || '';
  assert.doesNotMatch(listMatch, /gomoku|drawing|invited/);
  assert.doesNotMatch(source, /\.eq\('status',\s*'invited'\)/);
});
