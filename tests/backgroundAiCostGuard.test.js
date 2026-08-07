const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const guard = fs.readFileSync(path.resolve(__dirname, '..', 'backgroundAiCostGuardPatch.js'), 'utf8');
const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');

test('memory journal previously fell back to the active Chat model', () => {
  assert.match(server, /MEMORY_JOURNAL_MODEL\s*\|\|\s*settings\?\.memory_journal_model\s*\|\|\s*settings\?\.selected_model/);
});

test('background cost guard handles memory journal locally unless explicitly configured', () => {
  assert.match(guard, /请为 OurHome 的记忆日志分析刚刚这一轮聊天/);
  assert.match(guard, /process\.env\.MEMORY_JOURNAL_MODEL/);
  assert.match(guard, /if \(!dedicatedModel\)/);
  assert.match(guard, /localAnthropicResponse\(localMemoryJournal\(body\)\)/);
  assert.match(guard, /usage: \{ input_tokens: 0, output_tokens: 0 \}/);
});

test('explicit memory journal provider calls are purpose-labelled', () => {
  assert.match(guard, /X-OurHome-Call-Purpose[^\n]*memory-journal/);
  assert.match(guard, /body: JSON\.stringify\(nextBody\)/);
});
