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

test('聊天提示词要求每轮都有原生或模拟思考', () => {
  const prompt = buildChatResponseRules(300);
  assert.match(prompt, /中文表达自然、流畅、有生活感/);
  assert.match(prompt, /【每轮可见思考】/);
  assert.match(prompt, /每一轮聊天都要有可见思考/);
  assert.match(prompt, /reasoning_content/);
  assert.match(prompt, /完整放进“想了想”区域/);
  assert.match(prompt, /没有返回原生思考字段/);
  assert.match(prompt, /<thinking>/);
  assert.match(prompt, /简单问候或很直白的话题可以只写一句或很短一段/);
});

test('能力规则区分入口认知和实际读取权限', () => {
  const prompt = buildOurHomeCapabilityRule();
  assert.match(prompt, /工具实际提供并成功读取/);
  assert.match(prompt, /不得读取当前阅读进度之后的章节/);
  assert.match(prompt, /实际工具结果/);
});

test('小剧场提示词不混入主页功能导航', () => {
  const prompt = buildTheaterResponseRules(120);
  assert.doesNotMatch(prompt, /#reading/);
  assert.match(prompt, /小剧场自然推进规则/);
});
