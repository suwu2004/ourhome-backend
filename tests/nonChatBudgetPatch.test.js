const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  inferPurpose,
  isTheaterMemoryRequest,
  isTheaterRequest,
  preservesRequestedModel,
} = require('../nonChatBudgetPatch');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'nonChatBudgetPatch.js'), 'utf8');

test('main Chat, Toy Bear, and interactive Theater are exempt from the global non-Chat budget rewrite', () => {
  assert.match(source, /!heartbeat && isMainChatRequest\(url, body\)/);
  assert.match(source, /isToyboxRequest\(body\) \|\| isTheaterRequest\(body\)/);
  assert.match(source, /Interactive Chat, Toy Bear, and Theater keep their own selected model/);
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
  assert.match(source, /Theater memory is background maintenance/);
});

test('Happiness Diary and finished learning notes keep the active Chat model', () => {
  assert.equal(preservesRequestedModel('happiness-diary'), true);
  assert.equal(preservesRequestedModel('luze-learning-synthesis'), true);
  assert.equal(preservesRequestedModel('daily-mood'), false);
  assert.equal(preservesRequestedModel('luze-learning-plan'), false);
  assert.equal(inferPurpose({ messages: [{ role: 'user', content: '请写今天的幸福日记' }] }), 'happiness-diary');
  assert.equal(inferPurpose({ messages: [{ role: 'user', content: '请给心情日历留一句话' }] }), 'daily-mood');
  assert.match(source, /non_chat_model_policy: 'chat-writing-v6-cheap-heartbeat-theater-memory'/);
});

test('budget selector prefers explicit cheap hints and low-cost model families', () => {
  assert.match(source, /explicitPriceHint/);
  assert.match(source, /flash\[-_ \]\?lite\|nano/);
  assert.match(source, /haiku\|mini\|lite\|small/);
  assert.match(source, /opus\|pro\|max/);
  assert.match(source, /thinking\|reasoning/);
});

test('vision helpers only choose a cheap model that is actually vision-capable', () => {
  assert.match(source, /!vision \|\| isLikelyVisionModel\(model\)/);
  assert.match(source, /vision-reader/);
});

test('non-Chat work is blocked rather than silently falling back to an expensive active Chat model', () => {
  assert.match(source, /Never silently fall back to an expensive active Chat model/);
  assert.match(source, /ourhome_budget_model_unavailable/);
  assert.match(source, /blocked paid non-chat call/);
});

test('rewritten non-Chat calls are purpose-labelled for the API audit log', () => {
  assert.match(source, /X-OurHome-Call-Purpose/);
  assert.match(source, /non_chat_model_policy/);
  assert.match(source, /cheapest-except-chat-toybear-theater-v2/);
});
