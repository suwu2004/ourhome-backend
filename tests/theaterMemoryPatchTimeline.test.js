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
  assert.match(source, /anchor-character-plot-state-v3-cheap-refresh/);
});

test('theater organizer requests durable character memory without using the interactive model exemption', () => {
  assert.match(source, /"character_memory": ""/);
  assert.match(source, /character_memory 输出一份完整的“角色长期记忆”/);
  assert.match(source, /不能因为它很久没在最近对话出现就忘掉/);
  assert.match(source, /headers\.set\('X-OurHome-Call-Purpose', 'theater-memory'\)/);
});
