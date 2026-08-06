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

test('聊天提示词只保留指定语言、字数和事实规则', () => {
  const prompt = buildChatResponseRules(300);
  assert.match(prompt, /中文表达自然、流畅、有生活感。/);
  assert.match(prompt, /避免客服式、说明书式、模板化表达。/);
  assert.match(prompt, /【回复长度】/);
  assert.match(prompt, /【OurHome 房间与入口认知（事实规则）】/);
  assert.doesNotMatch(prompt, /【陆泽回复原则】/);
  assert.doesNotMatch(prompt, /保持独立思考和真实判断/);
  assert.doesNotMatch(prompt, /关注用户表达中的重点/);
  assert.doesNotMatch(prompt, /【每轮可见思考】/);
  assert.doesNotMatch(prompt, /reasoning_content/);
  assert.doesNotMatch(prompt, /<thinking>/);
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
