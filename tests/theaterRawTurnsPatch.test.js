const test = require('node:test');
const assert = require('node:assert/strict');

const { MARKER, buildStructuredMessages, splitHistoryEntries } = require('../theaterRawTurnsPatch');

test('剧场最近原始对话被拆成真正的 user/assistant 消息', () => {
  const body = {
    system: '你是 OurHome 的“小剧场”互动写作引擎。',
    messages: [{
      role: 'user',
      content: `【剧本名】
测试小世界

【世界观】
山间客栈。

【较早剧情提要】
两人昨天已经抵达客栈。

【最近互动记录】
叶檀：我把药瓶放到桌上。

陆泽：我接过药瓶，低头看了一眼。

叶檀：你刚才说会陪我回去。

【叶檀刚刚发来】
那你现在还算数吗？`,
    }],
  };

  const result = buildStructuredMessages(body);
  assert.match(result.system, new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.system, /测试小世界/);
  assert.equal(result.messages.length, 3);
  assert.deepEqual(result.messages.map(item => item.role), ['user', 'assistant', 'user']);
  assert.equal(result.messages[0].content, '我把药瓶放到桌上。');
  assert.equal(result.messages[1].content, '我接过药瓶，低头看了一眼。');
  assert.equal(result.messages[2].content, '你刚才说会陪我回去。\n\n那你现在还算数吗？');
});

test('同角色连续原始记录会合并，避免破坏 Anthropic 消息交替', () => {
  const entries = splitHistoryEntries('叶檀：第一句\n\n叶檀：第二句\n\n陆泽：接住。');
  assert.deepEqual(entries, [
    { label: '叶檀', text: '第一句' },
    { label: '叶檀', text: '第二句' },
    { label: '陆泽', text: '接住。' },
  ]);

  const result = buildStructuredMessages({
    system: '你是 OurHome 的“小剧场”互动写作引擎。',
    messages: [{
      role: 'user',
      content: `【剧本名】测试\n\n【最近互动记录】\n叶檀：第一句\n\n叶檀：第二句\n\n陆泽：接住。\n\n【叶檀刚刚发来】\n继续。`,
    }],
  });
  assert.deepEqual(result.messages.map(item => item.role), ['user', 'assistant', 'user']);
  assert.equal(result.messages[0].content, '第一句\n\n第二句');
});

test('当前输入已经存在于最近记录时不重复发送', () => {
  const result = buildStructuredMessages({
    system: '你是 OurHome 的“小剧场”互动写作引擎。',
    messages: [{
      role: 'user',
      content: `【剧本名】测试\n\n【最近互动记录】\n叶檀：已经发生。\n\n陆泽：已经回应。\n\n叶檀：最后一句。\n\n【叶檀刚刚发来】\n最后一句。`,
    }],
  });
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages.at(-1).content, '最后一句。');
});
