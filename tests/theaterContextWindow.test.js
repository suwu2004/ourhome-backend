'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { RECENT_MESSAGE_WINDOW, trimToRecentTheaterWindow } = require('../theaterContextWindowPatch');

test('Theater generation keeps the same 50-round message ceiling as formal Chat', () => {
  const messages = Array.from({ length: 120 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: index === 0 ? '【小剧场原始对话层·Raw Turns】 old' : `turn-${index}`,
  }));
  const body = {
    system: 'OurHome 的“小剧场”互动写作引擎\n独立小世界',
    messages,
  };
  const result = trimToRecentTheaterWindow(body);
  assert.equal(result.messages.length, RECENT_MESSAGE_WINDOW);
  assert.equal(result.messages[0].content, 'turn-20');
  assert.equal(result.messages.at(-1).content, 'turn-119');
});

test('Theater generation leaves a small history untouched and does not trim non-Theater requests', () => {
  const short = {
    system: 'OurHome 的“小剧场”互动写作引擎\n独立小世界',
    messages: [{ role: 'user', content: '【小剧场原始对话层·Raw Turns】 hi' }],
  };
  assert.equal(trimToRecentTheaterWindow(short), short);

  const nonTheater = {
    system: '普通聊天',
    messages: Array.from({ length: 120 }, (_, index) => ({ role: 'user', content: `chat-${index}` })),
  };
  assert.equal(trimToRecentTheaterWindow(nonTheater), nonTheater);
});
