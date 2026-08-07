const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'toyboxRoutePatch.js'), 'utf8');
const bootstrap = fs.readFileSync(path.resolve(__dirname, '..', 'runtimeBootstrap.js'), 'utf8');

test('runtime bootstrap loads toybox routes', () => {
  assert.match(bootstrap, /require\('\.\/toyboxRoutePatch'\);/);
  assert.match(bootstrap, /toybox: 'interactive-v1'/);
});

test('toybox exposes the four interactive game endpoints', () => {
  assert.match(source, /\/toybox\/harmony-round/);
  assert.match(source, /\/toybox\/secret-round/);
  assert.match(source, /\/toybox\/drawing-prompt/);
  assert.match(source, /\/toybox\/guess-drawing/);
});

test('harmony locks Lu Ze choice before the user choice is known', () => {
  assert.match(source, /在不知道叶檀会选什么的情况下先独立选 A 或 B/);
  assert.match(source, /luze_choice/);
});

test('secret code round is model-random and avoids recent answers', () => {
  assert.match(source, /不要被共同记忆绑死/);
  assert.match(source, /recent_answers/);
  assert.match(source, /最近出现过这些答案/);
});

test('drawing guess sends a real image block to the active model', () => {
  assert.match(source, /type: 'image'/);
  assert.match(source, /media_type/);
  assert.match(source, /guess-drawing/);
});

test('toybox trims the unrelated adult guide from lightweight game prompts', () => {
  assert.match(source, /indexOf\('【性爱指南】'\)/);
  assert.match(source, /personaOnly/);
});
