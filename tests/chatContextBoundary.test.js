'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MARKER, RULE, appendContextBoundary, hasBoundary } = require('../chatContextBoundary');

test('canonical boundary appends once to string system prompts', () => {
  const original = '【人设】陆泽\n【记忆】早餐是九个小煎包。';
  const first = appendContextBoundary(original);
  const second = appendContextBoundary(first);
  assert.match(first, /最后一条非空 user 消息/);
  assert.match(first, /早餐是九个小煎包/);
  assert.equal((second.match(new RegExp(MARKER, 'g')) || []).length, 1);
  assert.equal(hasBoundary(second), true);
});

test('canonical boundary is added to Anthropic content blocks without dropping existing blocks', () => {
  const original = [
    { type: 'text', text: '人设正文' },
    { type: 'text', text: '【记忆】早餐是九个小煎包。' },
  ];
  const bounded = appendContextBoundary(original);
  assert.equal(bounded.length, 2);
  assert.equal(bounded[0].text, original[0].text);
  assert.match(bounded[1].text, /早餐是九个小煎包/);
  assert.match(bounded[1].text, new RegExp(MARKER));
  assert.equal((bounded.map(block => block.text).join('\n').match(new RegExp(MARKER, 'g')) || []).length, 1);
});

test('empty or non-text system values receive a standalone boundary', () => {
  assert.equal(appendContextBoundary(null), RULE);
  assert.equal(appendContextBoundary([])[0].text, RULE);
});