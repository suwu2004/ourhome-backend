const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_LIVE_MESSAGE_TOKENS, trimTheaterStaticContext, trimRecentTheaterMessages, patchBody } = require('../theaterPromptBudgetPatch');

test('Theater static worldbook/rules/memory blocks are tightly bounded without changing recent messages', () => {
  const huge = '甲'.repeat(20000);
  const system = [
    '你是 OurHome 的“小剧场”互动写作引擎。',
    '【小剧场请求上下文】',
    '【小剧场通用规则】', huge,
    '【完整世界书】', huge,
    '【世界观/剧情设定】', huge,
    '【角色卡/关系】', huge,
    '【禁区/写作规则】', huge,
    '【角色与剧情记忆】', huge,
    '【本书称呼】', '叶檀：叶檀。', '陆泽：陆泽。',
  ].join('\n');
  const trimmed = trimTheaterStaticContext(system);
  assert.ok(trimmed.length < system.length);
  assert.match(trimmed, /最近真实对话不受此限制/);
  assert.match(trimmed, /【本书称呼】/);
  assert.ok(trimmed.length < 7000);
});

test('budget guard never trims or rewrites a small structured recent exchange', () => {
  const body = {
    system: 'OurHome 的“小剧场”互动写作引擎\n【小剧场请求上下文】\n【完整世界书】' + '甲'.repeat(20000),
    messages: [
      { role: 'user', content: '上一轮用户说的具体话。' },
      { role: 'assistant', content: '上一轮角色真正的回应。' },
      { role: 'user', content: '这一轮用户刚刚说的话。' },
    ],
  };
  const patched = patchBody(body);
  assert.deepEqual(patched.messages, body.messages);
  assert.equal(patched.messages.at(-1).content, '这一轮用户刚刚说的话。');
});

test('live dialogue token budget removes only the oldest turns and keeps the current exchange', () => {
  const messages = Array.from({ length: 18 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${index === 0 ? '最早的对话' : '对话'}${'甲'.repeat(700)}`,
  }));
  const trimmed = trimRecentTheaterMessages(messages);
  const total = trimmed.reduce((sum, message) => sum + 16 + message.content.length, 0);
  assert.ok(trimmed.length < messages.length);
  assert.equal(trimmed.at(-1).content, messages.at(-1).content);
  assert.ok(total <= MAX_LIVE_MESSAGE_TOKENS);
  assert.equal(trimmed[0].role, 'user');
});

test('token trimming never leaves an orphan assistant as the first live message', () => {
  const messages = [
    { role: 'user', content: '甲'.repeat(700) },
    { role: 'assistant', content: '乙'.repeat(700) },
    { role: 'user', content: '丙'.repeat(700) },
    { role: 'assistant', content: '丁'.repeat(700) },
    { role: 'user', content: '戊'.repeat(700) },
  ];
  const trimmed = trimRecentTheaterMessages(messages, 1500);
  assert.equal(trimmed[0].role, 'user');
  assert.equal(trimmed.at(-1).content, '戊'.repeat(700));
});
