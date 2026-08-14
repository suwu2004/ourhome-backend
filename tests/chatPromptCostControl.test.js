const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const ledger = fs.readFileSync(path.join(root, 'contextLedgerPatch.js'), 'utf8');

test('所有主 Chat 生成路径都使用意图工具路由', () => {
  const matches = server.match(/selectChatTools\(\[\.\.\.ACTION_TOOLS, \.\.\.dynamic\.tools\], recentHistory\)/g) || [];
  assert.equal(matches.length, 3);
  assert.doesNotMatch(server, /const toolsParam = \[\.\.\.ACTION_TOOLS, \.\.\.dynamic\.tools\]/);
});

test('Chat 与滚动账本共享 max_context_tokens 窗口', () => {
  assert.match(server, /maxTokens: settings\?\.max_context_tokens/);
  assert.match(server, /const maxContextTokens = settings\?\.max_context_tokens \|\| 0/g);
  assert.match(ledger, /select\('max_context_rounds, max_context_tokens'\)/);
  assert.match(ledger, /selectRecentHistory\(history/);
});

test('Chat 最近信件只注入短悄悄话，剧场规则不再误入', () => {
  assert.match(server, /\.eq\('category', '悄悄话'\)[\s\S]*?\.is\('parent_id', null\)/);
  assert.match(server, /compactBlock\(l\.content, 420\)/);
});

test('小剧场生成直接读取启用中的范围化规则', () => {
  assert.match(server, /async function readEffectiveTheaterRules/);
  assert.match(server, /loadCompiledRules\(supabase, 'theater'\)/);
  assert.equal((server.match(/compactBlock\(await readEffectiveTheaterRules\(\), 20000\)/g) || []).length, 2);
});
