const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'toyboxRoutePatch.js'), 'utf8');
const bootstrap = fs.readFileSync(path.resolve(__dirname, '..', 'runtimeBootstrap.js'), 'utf8');

test('runtime bootstrap loads toybox routes', () => {
  assert.match(bootstrap, /require\('\.\/toyboxRoutePatch'\);/);
  assert.match(bootstrap, /toybox: 'interactive-budget-v2'/);
});

test('toybox exposes the four interactive game endpoints', () => {
  assert.match(source, /\/toybox\/harmony-round/);
  assert.match(source, /\/toybox\/secret-round/);
  assert.match(source, /\/toybox\/drawing-prompt/);
  assert.match(source, /\/toybox\/guess-drawing/);
});

test('harmony locks Lu Ze choice before the user choice is known', () => {
  assert.match(source, /在不知道叶檀会选什么的情况下先独立选 A 或 B/);
  assert.match(source, /叶檀此刻还没看到这些题/);
  assert.match(source, /luze_choice/);
});

test('secret code round is model-random and avoids recent answers', () => {
  assert.match(source, /不要被共同记忆绑死/);
  assert.match(source, /recent_answers/);
  assert.match(source, /最近出现过这些答案/);
});

test('drawing guess sends a real image block to the selected budget model', () => {
  assert.match(source, /type: 'image'/);
  assert.match(source, /media_type/);
  assert.match(source, /loadRuntime\(req\.body\?\.model\)/);
});

test('toybox can batch rounds so repeated play does not require one request per round', () => {
  assert.match(source, /clampInt\(req\.body\?\.count, 1, 12, 1\)/);
  assert.match(source, /一次生成 \$\{count\} 道/);
  assert.match(source, /"rounds"/);
  assert.match(source, /respondRounds/);
});

test('toybox trims unrelated prompt weight to reduce per-call token cost', () => {
  assert.match(source, /indexOf\('【性爱指南】'\)/);
  assert.match(source, /compactBlock\(clipped, 6_500\)/);
  assert.match(source, /\.limit\(10\)/);
  assert.match(source, /\.slice\(0, 6\)/);
});
