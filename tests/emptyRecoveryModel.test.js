const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');

test('空回只允许一次低成本救场，不携带 thinking 或 tools', () => {
  assert.match(server, /const recoveryModel = process\.env\.OURHOME_EMPTY_RECOVERY_MODEL \|\| '\[L\]claude-haiku-4-5-20251001'/);
  assert.match(server, /retrying once with cheap model=/);
  assert.match(server, /model: recoveryModel,/);
  assert.match(server, /thinking: undefined,/);
  assert.match(server, /tools: undefined,/);
  assert.match(server, /purpose: \(purpose \|\| 'chat'\) \+ '-empty-recovery'/);
  assert.equal((server.match(/empty-recovery/g) || []).length, 2);
});
