const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  LOREBOOK_MARKER,
  LOREBOOK_CONTEXT_CAP_MARKER,
  historyMessages,
  isMainChat,
  isProviderRequest,
  appendSystemBlock,
  lorebookBlock,
  contextBudgetSnapshot,
  extractImportFile,
} = require('../lorebookPatch');

test('provider detection covers Anthropic, OpenAI-compatible, and Responses routes only', () => {
  assert.equal(isProviderRequest('https://example.com/v1/messages', { model: 'claude' }), true);
  assert.equal(isProviderRequest('https://example.com/v1/chat/completions', { model: 'gpt' }), true);
  assert.equal(isProviderRequest('https://example.com/v1/responses', { model: 'gpt' }), true);
  assert.equal(isProviderRequest('https://example.com/rest/v1/messages', {}), false);
});

test('main Chat is identified by its stable factual and reply-length blocks', () => {
  assert.equal(isMainChat({ system: '【OurHome 房间与入口认知（事实规则）】\n【回复长度】' }), true);
  assert.equal(isMainChat({ system: '普通辅助请求' }), false);
});

test('history extraction reads text blocks and keeps a bounded recent window', () => {
  const messages = Array.from({ length: 110 }, (_, index) => ({ role: 'user', content: [{ type: 'text', text: `第${index}条` }] }));
  const history = historyMessages({ messages });
  assert.equal(history.length, 100);
  assert.equal(history[0], '第10条');
  assert.equal(history.at(-1), '第109条');
});

test('lorebook context appends once to string and block-array systems', () => {
  const block = lorebookBlock('【世界书：花园】\n花园在东边。', 'chat');
  const text = appendSystemBlock('基础人设', block);
  assert.match(text, new RegExp(LOREBOOK_MARKER));
  assert.equal(appendSystemBlock(text, block), text);

  const array = appendSystemBlock([{ type: 'text', text: '基础人设' }], block);
  assert.equal(array.length, 2);
  assert.equal(appendSystemBlock(array, block).length, 2);
});

test('theater lorebook guidance preserves formal Chat isolation', () => {
  assert.match(lorebookBlock('设定', 'theater'), /不能读取或改写正式 Chat 记忆/);
  assert.match(lorebookBlock('设定', 'chat'), /不能覆盖真实记忆/);
});

test('worldbook budget status reports only the compiled constant-context cap marker', () => {
  assert.deepEqual(contextBudgetSnapshot('abc'), { constant_context_chars: 3, reached_cap: false });
  const capped = `前文${LOREBOOK_CONTEXT_CAP_MARKER}`;
  assert.equal(contextBudgetSnapshot(capped).constant_context_chars, capped.length);
  assert.equal(contextBudgetSnapshot(capped).reached_cap, true);

  const source = fs.readFileSync(path.join(__dirname, '..', 'lorebookPatch.js'), 'utf8');
  assert.ok(source.indexOf("registerLorebookBudgetRoute(this, supabase)") < source.indexOf('registerLorebookRoutes(this'));
  assert.match(source, /basis: 'enabled-constant-context-v1'/);
});

test('JSON and text imports are read without executing embedded content', async () => {
  const json = await extractImportFile({ originalname: 'world.json', mimetype: 'application/json', buffer: Buffer.from('{"entries":{}}') });
  assert.equal(json, '{"entries":{}}');
  await assert.rejects(
    extractImportFile({ originalname: 'old.doc', mimetype: 'application/msword', buffer: Buffer.from('x') }),
    /另存为 \.docx/,
  );
});

test('runtime loads scoped lorebooks before the final intimacy boundary', () => {
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'runtimeBootstrap.js'), 'utf8');
  assert.match(runtime, /require\('\.\/lorebookPatch'\)/);
  assert.ok(runtime.indexOf("require('./lorebookPatch')") < runtime.indexOf("require('./intimacyFlowPatch')"));
});
