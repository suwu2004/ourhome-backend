const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');

test('空回只允许一次低成本救场，不携带 thinking 或 tools', () => {
  assert.match(server, /const recoveryModel = process\.env\.OURHOME_EMPTY_RECOVERY_MODEL \|\| process\.env\.NON_CHAT_MODEL \|\| await cheapestModel\(\) \|\| '\[A\]gemini-3\.1-flash-lite'/);
  assert.match(server, /retrying once with cheap model=/);
  assert.match(server, /model: recoveryModel,/);
  assert.match(server, /thinking: undefined,/);
  assert.match(server, /tools: undefined,/);
  assert.match(server, /purpose: \(purpose \|\| 'chat'\) \+ '-empty-recovery'/);
  assert.equal((server.match(/empty-recovery/g) || []).length, 2);
});

test('empty final model body is rejected before persistence', () => {
  assert.match(server, /error\.code = 'empty_model_response'/);
  assert.match(server, /模型返回了空正文，请重试/);
});

test('sendGenerationError exposes empty response code to the client', () => {
  assert.match(server, /if \(error\?\.code === 'empty_model_response'\)/);
  assert.match(server, /code: 'empty_model_response'/);
  assert.match(server, /status\(502\)/);
});
