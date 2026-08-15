'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { optimizeChatTools, appendEconomyRule } = require('../chatToolEconomy');

test('explicit account names do not require a vault pre-read', () => {
  const tools = optimizeChatTools([
    { name: 'read_cat_vault', description: 'old read description', input_schema: { type: 'object', properties: {} } },
    {
      name: 'record_cat_vault_transaction',
      description: 'old record description',
      input_schema: {
        type: 'object',
        properties: {
          account_id: { type: 'string', description: 'old id' },
          account_name: { type: 'string', description: 'old name' },
        },
      },
    },
  ]);
  assert.match(tools[0].description, /不要先调用|只有.*失败/);
  assert.match(tools[1].description, /同一个模型回合/);
  assert.match(tools[1].input_schema.properties.account_name.description, /无需先 read_cat_vault/);
  assert.match(tools[1].input_schema.properties.account_id.description, /不是必需/);
});

test('history and memory lookup tools tell the model not to retry across paid rounds', () => {
  const tools = optimizeChatTools([
    { name: 'search_chat_history', description: 'old', input_schema: { type: 'object', properties: {} } },
    { name: 'search_memories', description: 'old', input_schema: { type: 'object', properties: {} } },
  ]);
  assert.match(tools[0].description, /最多调用一次/);
  assert.match(tools[0].description, /不要换关键词连续重试/);
  assert.match(tools[0].description, /search_memories/);
  assert.match(tools[1].description, /聊天记录.*search_chat_history/);
});

test('tool economy rules are appended once without changing unrelated system blocks', () => {
  const once = appendEconomyRule('原始人格');
  const twice = appendEconomyRule(once);
  assert.match(once, /金库工具省钱规则/);
  assert.match(once, /记忆检索省钱规则/);
  assert.equal(twice, once);

  const blocks = appendEconomyRule([{ type: 'text', text: '原始人格' }]);
  assert.equal(blocks[0].text, '原始人格');
  assert.match(blocks.at(-2).text, /多笔已明确收支/);
  assert.match(blocks.at(-1).text, /每个回复最多调用一次/);
});

test('production bootstrap loads tool economy and history search resilience after prompt cleanup', () => {
  const bootstrap = fs.readFileSync(path.resolve(__dirname, '..', 'runtimeBootstrap.js'), 'utf8');
  const cleanup = bootstrap.indexOf("require('./chatPromptCleanupPatch')");
  const economy = bootstrap.indexOf("require('./chatToolEconomyPatch')");
  const searchResilience = bootstrap.indexOf("require('./chatHistorySearchResiliencePatch')");
  assert.ok(cleanup >= 0);
  assert.ok(economy > cleanup);
  assert.ok(searchResilience > economy);
});
