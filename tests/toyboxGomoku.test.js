const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const assistant = fs.readFileSync(path.resolve(__dirname, '..', 'toyboxAssistant.js'), 'utf8');

test('Gomoku is a real Toybox game available to main Chat', () => {
  assert.match(assistant, /'gomoku'/);
  assert.match(assistant, /enum: \['harmony', 'secret', 'drawing', 'gomoku'\]/);
  assert.match(assistant, /if \(game === 'gomoku'\) return '五子棋'/);
});

test('LuZe Gomoku invitations begin with a persisted center black move', () => {
  assert.match(assistant, /moves: \[\{ row: 7, col: 7, actor: 'luze' \}\]/);
  assert.match(assistant, /user_color: 'white'/);
  assert.match(assistant, /luze_color: 'black'/);
  assert.match(assistant, /turn: 'user'/);
});
