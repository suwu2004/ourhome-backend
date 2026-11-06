'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  inferPurpose,
  isTheaterMemoryRequest,
  isTheaterRequest,
  preservesRequestedModel,
  shouldPreserveRequestedModelForCall,
} = require('../nonChatBudgetPatch');

const source = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '..', 'nonChatBudgetPatch.js'), 'utf8');
const sharedChatPersona = [
  '【回复长度】普通聊天的回复长度规则',
  '【OurHome 房间与入口认知（事实规则）】聊天上下文说明',
];

test('foreground Chat pricing requires an explicit purpose, not inherited system-prompt markers', () => {
  const body = { system: sharedChatPersona.join('\n'), messages: [{ role: 'user', content: '早上好' }] };
  assert.equal(shouldPreserveRequestedModelForCall('chat', body), true);
  assert.equal(shouldPreserveRequestedModelForCall('non-chat-budget', body), false);
  assert.doesNotMatch(source, /isMainChatRequest\(url, body\)/);
});

test('background diary and mood tasks remain cheap even when they reuse the Chat persona', () => {
  const body = {
    system: [...sharedChatPersona, '【心情日历边界】后台记录任务'].join('\n'),
    messages: [{ role: 'user', content: '给今天留一段心情' }],
  };
  assert.equal(shouldPreserveRequestedModelForCall('daily-mood', body), false);
  assert.equal(shouldPreserveRequestedModelForCall('home-memo', body), false);
  assert.equal(shouldPreserveRequestedModelForCall('memory-dream-review', body), false);
});

test('heartbeat is explicitly recognized and stays on the cheap background path', () => {
  const body = {
    system: sharedChatPersona.join('\n'),
    messages: [{ role: 'user', content: '这不是叶檀刚发来的消息，而是自动心跳提醒你' }],
  };
  assert.equal(inferPurpose(body), 'automation-heartbeat');
  assert.equal(shouldPreserveRequestedModelForCall('automation-heartbeat', body), false);
});

test('Happiness Diary and final learning synthesis retain the intended Chat model', () => {
  const body = { system: sharedChatPersona.join('\n'), messages: [{ role: 'user', content: '写日记' }] };
  assert.equal(preservesRequestedModel('happiness-diary'), true);
  assert.equal(preservesRequestedModel('luze-learning-synthesis'), true);
  assert.equal(shouldPreserveRequestedModelForCall('happiness-diary', body), true);
  assert.equal(shouldPreserveRequestedModelForCall('luze-learning-synthesis', body), true);
  assert.equal(shouldPreserveRequestedModelForCall('luze-learning-plan', body), false);
});

test('interactive Theater stays user-selected while Theater memory is cheap background work', () => {
  const interactive = {
    system: '你是 OurHome 的“小剧场”互动写作引擎',
    messages: [{ role: 'user', content: '【剧本名】\n高木彦' }],
  };
  const memory = {
    system: '你是“角色与剧情记忆整理器”。只整理资料，不扮演角色。',
    messages: [{ role: 'user', content: '请更新这本互动剧场的持续记忆。' }],
  };
  assert.equal(isTheaterRequest(interactive), true);
  assert.equal(isTheaterMemoryRequest(interactive), false);
  assert.equal(isTheaterMemoryRequest(memory), true);
  assert.equal(isTheaterRequest(memory), false);
  assert.equal(inferPurpose(memory), 'theater-memory');
  assert.equal(shouldPreserveRequestedModelForCall('theater-memory', memory), false);
  assert.equal(shouldPreserveRequestedModelForCall('theater', interactive), true);
  assert.match(source, /Theater memory is deliberately/);
});

test('Toy Bear remains a model-preserving exception', () => {
  assert.equal(shouldPreserveRequestedModelForCall('non-chat-budget', {
    system: '【玩具熊】互动模式',
    messages: [],
  }), true);
});

test('AgentMail inbox reading is excluded from the foreground Chat pricing exemption', () => {
  const body = {
    system: sharedChatPersona.join('\n'),
    tools: [{ name: 'check_agentmail_inbox', description: '读取收件箱' }],
    messages: [{ role: 'user', content: '查看收件箱里的邮件' }],
  };
  assert.equal(shouldPreserveRequestedModelForCall('chat', body), false);
});

test('budget selector retains its low-cost and vision safety filters', () => {
  assert.match(source, /explicitPriceHint/);
  assert.match(source, /flash\[-_ \]\?lite\|nano/);
  assert.match(source, /haiku\|mini\|lite\|small/);
  assert.match(source, /opus\|pro\|max/);
  assert.match(source, /thinking\|reasoning/);
  assert.match(source, /!vision \|\| isLikelyVisionModel\(model\)/);
});

test('unavailable low-cost models are blocked instead of falling back to a costly Chat model', () => {
  assert.match(source, /Never silently fall back to an expensive active Chat model/);
  assert.match(source, /ourhome_budget_model_unavailable/);
  assert.match(source, /blocked paid non-chat call/);
});

test('background selector only returns Flash-family models, preferring Flash Lite', () => {
  assert.equal(pickBudgetModel([
    'claude-haiku-4-5',
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash',
    'gemini-3.1-flash-lite',
    'claude-opus-4-6',
  ]), 'gemini-3.1-flash-lite');
  assert.equal(pickBudgetModel(['claude-haiku-4-5', 'gemini-3.1-pro-preview']), '');
});

test('vision background selector only returns vision-capable Flash models', () => {
  assert.equal(pickBudgetModel([
    'gemini-3.1-flash-lite',
    'gemini-3.1-flash',
    'gemini-3.1-pro-vision',
  ], { vision: true }), 'gemini-3.1-flash');
});

test('rewritten non-Chat calls carry the effective task purpose into usage logs', () => {
  assert.match(source, /headers\.set\('X-OurHome-Call-Purpose', effectivePurpose\)/);
});
