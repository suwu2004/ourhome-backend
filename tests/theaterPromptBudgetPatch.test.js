const test = require('node:test');
const assert = require('node:assert/strict');

const { trimTheaterStaticContext, patchBody } = require('../theaterPromptBudgetPatch');

test('Theater static worldbook/rules blocks are bounded without changing recent messages', () => {
  const huge = '甲'.repeat(20000);
  const system = [
    '你是 OurHome 的“小剧场”互动写作引擎。',
    '【小剧场请求上下文】',
    '【小剧场通用规则】', huge,
    '【完整世界书】', huge,
    '【世界观/剧情设定】', huge,
    '【角色卡/关系】', huge,
    '【禁区/写作规则】', huge,
    '【本书称呼】', '叶檀：叶檀。', '陆泽：陆泽。',
  ].join('\n');
  const trimmed = trimTheaterStaticContext(system);
  assert.ok(trimmed.length < system.length);
  assert.match(trimmed, /最近真实对话不受此限制/);
  assert.match(trimmed, /【本书称呼】/);
});

test('budget guard never trims or rewrites structured recent user/assistant turns', () => {
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
