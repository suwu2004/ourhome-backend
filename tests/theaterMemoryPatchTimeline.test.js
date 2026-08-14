const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'theaterMemoryPatch.js'), 'utf8');

test('queued theater memory refreshes yield until the reply can persist', () => {
  assert.match(source, /new Promise\(resolve => setImmediate\(resolve\)\)/);
});

test('queued theater memory refreshes re-read the latest saved baseline', () => {
  assert.match(source, /freshMemory = await readMemory\(bookRow\.id\)/);
  assert.match(source, /const baseline = freshMemory \|\| memory \|\| emptyTheaterMemory\(\)/);
  assert.match(source, /const existingId = freshMemory\?\.id \|\| memory\?\.id \|\| null/);
});

test('theater memory prompts pin current state to the newest timeline edge', () => {
  assert.match(source, /最新一轮·时间线最前沿/);
  assert.match(source, /绝不能退回最近记录里的旧地点、旧动作或旧关系状态/);
  assert.match(source, /anchor-plot-state-v2-ordered-refresh/);
});
