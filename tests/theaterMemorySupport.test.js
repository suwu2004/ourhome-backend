const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMemoryPromptBlock,
  extractTheaterRequestContext,
  injectMemoryIntoBody,
  mergeTheaterFacts,
  normalizeTheaterMemory,
  sampleTheaterHistory,
  shouldRefreshMemory,
} = require('../theaterMemorySupport');

test('extracts theater title names and latest user input', () => {
  const body = {
    messages: [{
      role: 'user',
      content: `【剧本名】\n高木彦\n\n【本书称呼】\n叶檀：叶檀在这本书里的名字或称呼。\n高木彦：你在这本书里承担的角色、旁白或对手戏称呼。\n\n【叶檀刚刚发来】\n你还记得第一次见面吗？\n\n【玩法】\n互动推进`,
    }],
  };
  const context = extractTheaterRequestContext(body);
  assert.equal(context.title, '高木彦');
  assert.equal(context.userName, '叶檀');
  assert.equal(context.assistantName, '高木彦');
  assert.equal(context.latestUserText, '你还记得第一次见面吗？');
});

test('injects layered memory before theater history and replaces an old block', () => {
  const body = {
    messages: [{
      role: 'user',
      content: `【剧本名】\n测试\n\n【角色与剧情记忆】\n旧内容\n\n【较早剧情提要】\n旧剧情\n【最近互动记录】\n新剧情`,
    }],
  };
  const next = injectMemoryIntoBody(body, {
    character_anchor: '外冷内热，不轻易承诺。',
    relationship_memory: '两人已经确认恋爱关系。',
    plot_facts: ['第一次见面发生在雨夜。'],
    current_state: '两人正在车站等车。',
    open_threads: ['尚未解释那封信。'],
    locked_notes: '称呼固定为宝宝。',
  });
  const text = next.messages[0].content;
  assert.match(text, /【角色与剧情记忆】/u);
  assert.match(text, /称呼固定为宝宝/u);
  assert.match(text, /第一次见面发生在雨夜/u);
  assert.doesNotMatch(text, /旧内容/u);
  assert.ok(text.indexOf('【角色与剧情记忆】') < text.indexOf('【较早剧情提要】'));
});

test('normalizes and caps theater memory lists with v2 budgets', () => {
  const memory = normalizeTheaterMemory({
    plot_facts: Array.from({ length: 70 }, (_, index) => `事实 ${index}`),
    open_threads: Array.from({ length: 20 }, (_, index) => `线索 ${index}`),
    turns_since_refresh: 99,
  });
  assert.equal(memory.version, 2);
  assert.equal(memory.plot_facts.length, 60);
  assert.equal(memory.open_threads.length, 16);
  assert.equal(memory.turns_since_refresh, 30);
});

test('history sampling preserves the beginning and latest events', () => {
  const rows = Array.from({ length: 120 }, (_, index) => ({
    author: index % 2 === 0 ? '檀' : '泽',
    content: `第 ${index + 1} 条剧情`,
  }));
  const sampled = sampleTheaterHistory(rows, {
    userName: '叶檀',
    assistantName: '陆泽',
    maxChars: 30000,
  });
  assert.match(sampled, /第 1 条剧情/u);
  assert.match(sampled, /第 120 条剧情/u);
  assert.match(sampled, /第 60 条剧情|第 61 条剧情/u);
});

test('refreshes every third turn or immediately after a significant event', () => {
  assert.equal(shouldRefreshMemory({ character_anchor: '', plot_facts: [] }, '', ''), true);
  assert.equal(shouldRefreshMemory({ character_anchor: '稳定', plot_facts: ['事实'], turns_since_refresh: 1 }, '普通聊天', '普通回复'), false);
  assert.equal(shouldRefreshMemory({ character_anchor: '稳定', plot_facts: ['事实'], turns_since_refresh: 2 }, '普通聊天', '普通回复'), true);
  assert.equal(shouldRefreshMemory({ character_anchor: '稳定', plot_facts: ['事实'], turns_since_refresh: 0 }, '我答应和你结婚', '他愣住了'), true);
});

test('incremental theater facts merge without deleting old unique events', () => {
  const merged = mergeTheaterFacts(['第一次见面是在雨夜', '答应会回来'], ['答应会回来', '一起搬进新家'], 60);
  assert.deepEqual(merged, ['第一次见面是在雨夜', '答应会回来', '一起搬进新家']);
});

test('memory prompt separates archived and recent plot facts', () => {
  const facts = Array.from({ length: 45 }, (_, index) => `事件 ${index + 1}`);
  const prompt = buildMemoryPromptBlock({ plot_facts: facts });
  assert.match(prompt, /长期事件档案/);
  assert.match(prompt, /近期核心剧情事实/);
  assert.match(prompt, /事件 1/);
  assert.match(prompt, /事件 45/);
});
