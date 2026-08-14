const test = require('node:test');
const assert = require('node:assert/strict');

const {
  estimateTextTokens,
  estimateMessageTokens,
  selectRecentHistory,
} = require('../chatContextWindow');

function row(id, content) {
  return { id, role: id % 2 ? 'user' : 'assistant', content };
}

test('中英文采用保守的本地 token 估算', () => {
  assert.equal(estimateTextTokens('今天开心'), 4);
  assert.equal(estimateTextTokens('abcdefgh'), 2);
  assert.ok(estimateMessageTokens(row(1, '今天开心')) > 4);
});

test('最近上下文同时受轮数和 token 预算约束', () => {
  const history = Array.from({ length: 30 }, (_, index) => row(index + 1, '这是一条有一定长度的聊天消息'.repeat(4)));
  const selected = selectRecentHistory(history, { maxRounds: 10, maxTokens: 260 });
  assert.ok(selected.length < 20);
  assert.equal(selected.at(-1).id, 30);
  assert.deepEqual(selected.map(item => item.id), [...selected].sort((a, b) => a.id - b.id).map(item => item.id));
});

test('再小的预算也保留当前往返所需的最后两条', () => {
  const history = [row(1, '旧消息'), row(2, '很长'.repeat(500)), row(3, '最新消息')];
  assert.deepEqual(
    selectRecentHistory(history, { maxRounds: 50, maxTokens: 10 }).map(item => item.id),
    [2, 3],
  );
});

test('未设置 token 预算时仍按原有轮数截取', () => {
  const history = Array.from({ length: 12 }, (_, index) => row(index + 1, '短消息'));
  assert.deepEqual(selectRecentHistory(history, { maxRounds: 3, maxTokens: 0 }).map(item => item.id), [7, 8, 9, 10, 11, 12]);
});
