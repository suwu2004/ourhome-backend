'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MARKER, appendGuard, guardCurrentTurn } = require('../chatCurrentTurnGuardPatch');

test('current-turn guard is appended once to string systems', () => {
  const first = appendGuard('base system');
  assert.match(first, /最后一条非空 user 消息/);
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
  assert.match(next.system, /最近原始对话是承接上下文的第一手材料/);
  assert.match(next.system, /不要再次询问她刚刚已经回答过的信息/);
  assert.match(next.system, /用户明确纠正过的事实优先/);
  assert.match(next.system, /只有原始对话确实没有提供必要答案时/);
  assert.equal(next.messages.at(-1).content, '这一条才是现在的问题');
});

test('array system preserves existing blocks and appends one boundary to the last text block', () => {
  const system = [{ type: 'text', text: 'base' }];
  const first = appendGuard(system);
  assert.equal(first.length, 1);
  assert.match(first[0].text, /^base/);
  assert.match(first[0].text, new RegExp(MARKER));
  const second = appendGuard(first);
  assert.equal(second.length, 1);
  assert.equal((second[0].text.match(new RegExp(MARKER, 'g')) || []).length, 1);
});
