const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  LEDGER_REFRESH_MESSAGE_DELTA,
  overflowRows,
  rowsAfterCursor,
  splitRowsIntoChunks,
  shouldRefreshLedger,
  buildLedgerUpdatePrompt,
  localLedgerSummary,
  buildLedgerBlock,
  normalizeLedgerSummary,
} = require('../contextLedgerSupport');

const patchSource = fs.readFileSync(path.resolve(__dirname, '..', 'contextLedgerPatch.js'), 'utf8');

function row(id, role = 'user', content = `消息 ${id}`) {
  return { id, role, content, attachment_summary: null };
}

test('只把最近上下文窗口之外的历史交给滚动账本', () => {
  const history = Array.from({ length: 120 }, (_, index) => row(index + 1));
  const overflow = overflowRows(history, 100);
  assert.equal(overflow.length, 20);
  assert.equal(overflow[0].id, 1);
  assert.equal(overflow.at(-1).id, 20);
});

test('账本游标之后的旧消息按顺序继续，不会重复记账', () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(index + 1));
  assert.deepEqual(rowsAfterCursor(rows, 8).map(item => item.id), [9, 10, 11, 12]);
  assert.deepEqual(rowsAfterCursor(rows, null).map(item => item.id), rows.map(item => item.id));
});

test('分块保持消息顺序并尊重字符水位', () => {
  const rows = Array.from({ length: 8 }, (_, index) => row(index + 1, index % 2 ? 'assistant' : 'user', 'x'.repeat(1200)));
  const chunks = splitRowsIntoChunks(rows, 4000);
  assert.ok(chunks.length >= 2);
  assert.deepEqual(chunks.flat().map(item => item.id), rows.map(item => item.id));
});

test('第一次溢出立即建账，之后小增量用桥接，大增量再滚动整理', () => {
  const pendingSmall = [row(101), row(102)];
  const pendingLarge = Array.from({ length: LEDGER_REFRESH_MESSAGE_DELTA }, (_, index) => row(101 + index));
  assert.equal(shouldRefreshLedger(null, pendingSmall), true);
  const ledger = { summary: '已有账本', summarized_through_message_id: 100 };
  assert.equal(shouldRefreshLedger(ledger, pendingSmall), false);
  assert.equal(shouldRefreshLedger(ledger, pendingLarge), true);
});

test('更新提示保留旧账本与新增旧历史，但隐藏控制不会进入账本输入', () => {
  const prompt = buildLedgerUpdatePrompt('旧事实', [row(2, 'assistant', '正文\n<intimacy_control action="hold"/>')], { coveredBefore: 1 });
  assert.match(prompt, /旧事实/);
  assert.match(prompt, /陆泽：正文/);
  assert.doesNotMatch(prompt, /intimacy_control/);
});

test('本地账本整理不调用模型也能保留旧摘要和最新溢出对话', () => {
  const summary = localLedgerSummary('已有稳定事实', [
    row(101, 'user', '新的旧消息 A'),
    row(102, 'assistant', '新的旧消息 B'),
  ]);
  assert.match(summary, /已有稳定事实/);
  assert.match(summary, /新的旧消息 A/);
  assert.match(summary, /新的旧消息 B/);
  assert.ok(summary.length <= 6000);
});

test('隐藏账本默认绝不继承当前 Chat 模型，付费模式也一轮最多一次', () => {
  assert.match(patchSource, /process\.env\.CONTEXT_LEDGER_MODEL/);
  assert.doesNotMatch(patchSource, /CONTEXT_LEDGER_MODEL\s*\|\|\s*mainBody/);
  assert.match(patchSource, /PAID_LEDGER_MAX_CHUNKS_PER_TURN\s*=\s*1/);
  assert.match(patchSource, /X-OurHome-Call-Purpose[^\n]*context-ledger/);
  assert.match(patchSource, /rolling-local-first-v2/);
});

test('注入块包含滚动账本和紧邻最近窗口的桥接旧消息', () => {
  const block = buildLedgerBlock({
    summary: '长期接续事实',
    bridgeRows: [row(91, 'user', '刚被挤出的上下文'), row(92, 'assistant', '接住这件事')],
    coveredCount: 80,
    overflowCount: 92,
  });
  assert.match(block, /长期接续事实/);
  assert.match(block, /刚被挤出的上下文/);
  assert.match(block, /80\/92/);
  assert.match(block, /最近可见对话冲突，以最近对话为准/);
});

test('模型返回的账本会去掉代码块和内部控制标签', () => {
  const value = normalizeLedgerSummary('```text\n事实 A\n<intimacy_control action="stop"/>\n```');
  assert.equal(value, '事实 A');
});
