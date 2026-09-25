'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compactTheaterHistory } = require('../theaterHistoryTail');

test('Theater history cap keeps the newest turns instead of the oldest head', () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `第${index + 1}轮：${'很长的剧情内容。'.repeat(120)}`,
  }));
  const result = compactTheaterHistory(rows, row => row.content, 18000);
  assert.match(result, /第30轮/);
  assert.match(result, /第29轮/);
  assert.doesNotMatch(result, /第1轮/);
});

test('Theater history cap does not drop the newest single oversized turn', () => {
  const result = compactTheaterHistory(
    [{ content: '旧内容' }, { content: '最新内容'.repeat(10000) }],
    row => row.content,
    18000,
  );
  assert.match(result, /最新内容/);
  assert.doesNotMatch(result, /旧内容/);
});
