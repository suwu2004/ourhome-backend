'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MARKER, appendGuard, guardCurrentTurn } = require('../chatCurrentTurnGuardPatch');

test('current-turn guard is appended once to string systems', () => {
  const first = appendGuard('base system');
  assert.match(first, /最后一条 user 消息/);
  assert.equal((first.match(new RegExp(MARKER, 'g')) || []).length, 1);
  const second = appendGuard(first);
  assert.equal((second.match(new RegExp(MARKER, 'g')) || []).length, 1);
});

test('current-turn guard preserves provider messages unchanged', () => {
  const body = {
    system: 'base',
    messages: [
      { role: 'user', content: '上一条' },
      { role: 'assistant', content: '旧回复' },
      { role: 'user', content: '这一条才是现在的问题' },
    ],
  };
  const next = guardCurrentTurn(body);
  assert.deepEqual(next.messages, body.messages);
  assert.match(next.system, /当前对话原文优先于窗口简介/);
  assert.match(next.system, /不要再次询问她刚刚已经回答过的信息/);
  assert.match(next.system, /用户明确纠正过的事实优先/);
  assert.match(next.system, /只有原始对话确实没有提供答案时/);
  assert.equal(next.messages.at(-1).content, '这一条才是现在的问题');
});

test('array system keeps existing blocks and adds one guard block', () => {
  const system = [{ type: 'text', text: 'base' }];
  const first = appendGuard(system);
  assert.equal(first.length, 2);
  assert.equal(first[0].text, 'base');
  const second = appendGuard(first);
  assert.equal(second.length, 2);
});
