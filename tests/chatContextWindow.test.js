const test = require('node:test');
const assert = require('node:assert/strict');

const {
  estimateTextTokens,
  estimateMessageTokens,
  findArchivedHistoryPrefix,
  shouldSummarizeArchivedMessages,
  selectRecentHistory,
} = require('../chatContextWindow');

function row(id, content) {
  return { id, role: id % 2 ? 'user' : 'assistant', content };
}


test('窗口总结只覆盖当前原始上下文之外的连续历史前缀', () => {
  const history = Array.from({ length: 30 }, (_, index) => ({
    ...row(index + 1, `消息 ${index + 1}`),
    created_at: new Date(Date.now() - (30 - index) * 60_000).toISOString(),
  }));
  const context = history.slice(-8);
  assert.deepEqual(
    findArchivedHistoryPrefix(history, context).map(item => item.id),
    Array.from({ length: 22 }, (_, index) => index + 1),
  );
});

test('窗口总结不会提前吸收被额外保留在上下文里的近期事实', () => {
  const history = Array.from({ length: 30 }, (_, index) => row(index + 1, `消息 ${index + 1}`));
  const context = [history[1], ...history.slice(-8)];
  assert.deepEqual(
    findArchivedHistoryPrefix(history, context).map(item => item.id),
    [1],
  );
});

test('窗口总结在已归档消息达到数量或 token 阈值时触发', () => {
  const small = Array.from({ length: 11 }, (_, index) => row(index + 1, '短消息'));
  assert.equal(shouldSummarizeArchivedMessages(small), false);
  assert.equal(shouldSummarizeArchivedMessages([...small, row(12, '短消息')]), true);
  assert.equal(shouldSummarizeArchivedMessages([row(1, '今天'.repeat(6000))]), true);
});

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


test('the ledger can calculate a contiguous suffix without recent-life extras', () => {
  const now = new Date().toISOString();
  const history = Array.from({ length: 12 }, (_, index) => ({
    ...row(index + 1, index === 0 ? '我今天上午去了学校上课。' : '普通消息'),
    created_at: now,
  }));
  const withProtectedFact = selectRecentHistory(history, { maxRounds: 2, maxTokens: 0 });
  const contiguous = selectRecentHistory(history, {
    maxRounds: 2,
    maxTokens: 0,
    protectRecentFacts: false,
  });
  assert.ok(withProtectedFact.some(item => item.id === 1));
  assert.deepEqual(contiguous.map(item => item.id), [9, 10, 11, 12]);
});
