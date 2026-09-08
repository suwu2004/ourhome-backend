const test = require('node:test');
const assert = require('node:assert/strict');
const {
  splitHistoryEntries,
  buildStructuredMessages,
} = require('../theaterRawTurnsPatch');

test('splitHistoryEntries parses the current numbered history format', () => {
  const result = splitHistoryEntries('1. 【2026-01-01 10:00】叶檀：你好\n\n2. 【2026-01-01 10:01】陆泽：你好呀');
  assert.equal(result.length, 2);
  assert.equal(result[0].label, '叶檀');
  assert.equal(result[1].label, '陆泽');
});

test('buildStructuredMessages restores user and assistant turns instead of one giant prompt', () => {
  const result = buildStructuredMessages({
    system: '你是 OurHome 的“小剧场”互动写作引擎。',
    messages: [{ role: 'user', content: '【剧本名】测试\n\n【最近互动记录】\n叶檀：上一句。\n陆泽：我接住。\n\n【叶檀刚刚发来】下一句。\n\n【玩法】\n互动。' }],
  });
  assert.deepEqual(result.messages.map(item => item.role), ['user', 'assistant', 'user']);
  assert.match(result.messages[0].content, /上一句。/);
  assert.match(result.messages.at(-1).content, /下一句。/);
});

test('最近互动超过窗口时保留完整的最近30条真实消息，而不是只留下当前输入', () => {
  const history = Array.from({ length: 24 }, (_, index) => index % 2 === 0
    ? `叶檀：用户历史${index}`
    : `陆泽：角色回应${index}`
  ).join('\n\n');
  const result = buildStructuredMessages({
    system: '你是 OurHome 的“小剧场”互动写作引擎。',
    messages: [{ role: 'user', content: `【剧本名】测试\n\n【最近互动记录】\n${history}\n\n【叶檀刚刚发来】当前输入\n\n【玩法】\n互动。` }],
  });
  assert.equal(result.messages.length, 25);
  assert.match(result.messages[0].content, /用户历史0/);
  assert.match(result.messages.at(-2).content, /角色回应23/);
  assert.match(result.messages.at(-1).content, /当前输入/);
});
