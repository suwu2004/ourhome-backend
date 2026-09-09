'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { maybeEnableThinking, modelSupportsNativeThinking, enrichResponseBody } = require('../theaterThinkingPatch');

test('Theater keeps native thinking disabled even for thinking-capable model names', () => {
  const body = {
    model: 'claude-opus-4-6',
    system: 'OurHome 的“小剧场”互动写作引擎',
    messages: [{ role: 'user', content: '接着演。' }],
    max_tokens: 1000,
  };
  assert.equal(modelSupportsNativeThinking(body.model), true);
  assert.equal(maybeEnableThinking(body).thinking, undefined);
  assert.equal(maybeEnableThinking(body), body);
});

test('Theater does not force thinking onto ordinary models', () => {
  const body = {
    model: 'claude-haiku-3-5',
    system: 'OurHome 的“小剧场”互动写作引擎',
    messages: [{ role: 'user', content: '接着演。' }],
  };
  assert.equal(modelSupportsNativeThinking(body.model), false);
  assert.equal(maybeEnableThinking(body).thinking, undefined);
});

test('Theater response exposes native reasoning without changing the visible reply text', () => {
  const body = {
    assistant_message: { role: 'assistant', content: '他抬眼看向你。' },
  };
  const patch = require('../theaterThinkingPatch');
  patch.remember(body.assistant_message.content, '我先接住她刚才的动作，再自然推进。');
  const result = enrichResponseBody(body);
  assert.equal(result.assistant_message.reasoning_content, '我先接住她刚才的动作，再自然推进。');
  assert.equal(result.assistant_message.content, body.assistant_message.content);
});
