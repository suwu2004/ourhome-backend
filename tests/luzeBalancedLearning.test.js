'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'luzePrivateRoomPatch.js'), 'utf8');

test('Luze learning alternates OurHome-related and free-curiosity rounds', () => {
  assert.match(source, /const learningMode = runsToday % 2 === 0 \? 'ourhome' : 'curiosity'/);
  assert.match(source, /learningMode === 'ourhome' \? await recentOurHomeContext\(\) : \[\]/);
  assert.match(source, /mode: learningMode, sharedContext/);
});

test('OurHome-related learning uses recent visible chat only as topic context', () => {
  assert.match(source, /async function recentOurHomeContext\(\)/);
  assert.match(source, /from\('messages'\)/);
  assert.match(source, /eq\('visible', true\)/);
  assert.match(source, /只提炼问题，不要把私密原话当搜索词/);
  assert.match(source, /不要搜索私密聊天原句/);
});

test('balanced planning adds no second planning model call', () => {
  assert.equal((source.match(/purpose: 'luze-learning-plan'/g) || []).length, 1);
  assert.equal((source.match(/async function recentOurHomeContext/g) || []).length, 1);
});

test('learning mode follows trails notes and ideas into the private room', () => {
  assert.ok((source.match(/learning_mode: learningMode/g) || []).length >= 3);
  assert.match(source, /complete mode=\$\{learningMode\}/);
});
