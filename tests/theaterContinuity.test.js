'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitHistoryEntries, buildStructuredMessages } = require('../theaterRawTurnsPatch');
const { shouldRefreshMemoryEconomically } = require('../theaterMemoryEconomyPatch');

const SYSTEM = '你是 OurHome 的“小剧场”互动写作引擎。';

function makeBody(history, current = '继续。') {
  return {
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `【剧本名】\n测试剧本\n\n【最近互动记录】\n${history}\n\n【叶檀刚刚发来】\n${current}`,
    }],
  };
}

test('splitHistoryEntries parses the current numbered history format', () => {
  const history = [
    '1. 【2026-09-06 02:10】叶檀：你刚才答应我的事情还算数吗？',
    '2. 【2026-09-06 02:11】陆泽：算数，我记得。',
    '3. 【2026-09-06 02:12】叶檀：那你现在告诉我答案。',
  ].join('\n');
  const entries = splitHistoryEntries(history);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].label, '叶檀');
  assert.equal(entries[1].label, '陆泽');
  assert.equal(entries[2].text, '那你现在告诉我答案。');
});

test('buildStructuredMessages restores user and assistant turns instead of one giant prompt', () => {
  const body = makeBody([
    '1. 【2026-09-06 02:10】叶檀：你刚才答应我的事情还算数吗？',
    '2. 【2026-09-06 02:11】陆泽：算数，我记得。',
    '3. 【2026-09-06 02:12】叶檀：那你现在告诉我答案。',
  ].join('\n'), '所以呢？');

  const structured = buildStructuredMessages(body);
  assert.ok(structured.system.includes('【小剧场原始对话层·Raw Turns】'));
  assert.deepEqual(structured.messages.map(message => message.role), ['user', 'assistant', 'user', 'user']);
  assert.match(structured.messages.at(-2).content, /那你现在告诉我答案/);
  assert.match(structured.messages.at(-1).content, /所以呢/);
});

test('memory economy does not refresh every turn just because character_memory is empty', () => {
  const memory = {
    character_anchor: '稳定角色设定',
    character_memory: '',
    plot_facts: [],
    current_state: '两人仍在客厅继续对话',
    turns_since_refresh: 0,
  };
  assert.equal(shouldRefreshMemoryEconomically(memory, '普通一句话', '普通回复'), false);
  assert.equal(shouldRefreshMemoryEconomically({ ...memory, turns_since_refresh: 5 }, '普通一句话', '普通回复'), true);
  assert.equal(shouldRefreshMemoryEconomically(memory, '我们结婚吧', '他答应了'), true);
});
