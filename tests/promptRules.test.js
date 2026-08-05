const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildOurHomeCapabilityRule,
  buildChatResponseRules,
  buildTheaterResponseRules,
} = require('../promptRules');

test('聊天提示词明确告诉陆泽共读小屋入口', () => {
  const prompt = buildChatResponseRules(300);
  assert.match(prompt, /共读小屋/);
  assert.match(prompt, /#reading/);
  assert.match(prompt, /主页/);
  assert.match(prompt, /书本图标/);
  assert.match(prompt, /不得回答“没有这个入口”/);
});

test('能力规则区分入口认知和实际读取权限', () => {
  const prompt = buildOurHomeCapabilityRule();
  assert.match(prompt, /知道入口存在/);
  assert.match(prompt, /已经读取书中数据/);
  assert.match(prompt, /工具列表真的提供共读读取能力/);
});

test('小剧场提示词不混入主页功能导航', () => {
  const prompt = buildTheaterResponseRules(120);
  assert.doesNotMatch(prompt, /#reading/);
  assert.match(prompt, /小剧场自然推进规则/);
});
