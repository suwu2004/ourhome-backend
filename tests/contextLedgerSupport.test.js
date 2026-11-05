const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  LEDGER_REFRESH_MESSAGE_DELTA,
  LEDGER_REFRESH_TOKEN_DELTA,
  estimateLedgerRowsTokens,
  parseLedgerModelResponse,
  parseLedgerEntries,
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
  return { id, role, content, attachment_name: null, attachment_type: null, attachment_summary: null };
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
  assert.match(patchSource, /rolling-summary-v5-semantic-fallback-attachments/);
  assert.match(patchSource, /attachment_name,attachment_type,attachment_summary/);
  assert.match(patchSource, /loadPendingOverflow/);
  assert.doesNotMatch(patchSource, /\.range\(offset/);
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

test('滚动账本会把附件名称与类型保留为上下文线索，不携带原始附件 URL', () => {
  const { rowText } = require('../contextLedgerSupport');
  const line = rowText({
    id: 300,
    role: 'user',
    content: '',
    attachment_name: '高一语文课表.xlsx',
    attachment_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    attachment_summary: '包含周一至周五的高一语文课时安排。',
    attachment_url: 'https://private.example/file-token',
    created_at: '2026-11-05T01:00:00.000Z',
  });
  assert.match(line, /高一语文课表.xlsx/);
  assert.match(line, /application\/vnd/);
  assert.doesNotMatch(line, /private\.example|file-token/);
});

test('模型自然语言摘要不会被本地兜底截断到前 900 字', () => {
  const legacy = [
    '【重要事实】',
    '叶檀长期偏好清晰自然的回复，明确不喜欢客服式模板语言。',
    '【项目进展】',
    'OurHome 已经完成前后端部署，当前继续完善聊天上下文和临时记忆。',
    '【待续话题】',
    '接下来要核对同一早晨的上下文是否能跨越窗口裁剪，并验证新的滚动摘要。',
    '【后续决定】',
    '最终决定保留原始聊天记录，只对旧消息做摘要，不删除任何消息。',
  ].join('\\n');
  const entries = parseLedgerEntries(legacy);
  assert.ok(entries.length >= 6);
  const summary = localLedgerSummary(legacy, [
    row(301, 'user', '今天上午确认了滚动摘要要同时保留附件名称与附件解析线索。'),
  ]);
  assert.match(summary, /客服式模板语言/);
  assert.match(summary, /保留原始聊天记录/);
  assert.match(summary, /附件名称/);
  assert.ok(summary.length <= 6000);
});

test('模型返回的账本会去掉代码块和内部控制标签', () => {
  const value = normalizeLedgerSummary('```text\n事实 A\n<intimacy_control action="stop"/>\n```');
  assert.equal(value, '事实 A');
});


test('滚动摘要按 32 条消息或约 6000 tokens 任一条件触发', () => {
  const ledger = { summary: '已有摘要', summarized_through_message_id: 100 };
  const small = Array.from({ length: LEDGER_REFRESH_MESSAGE_DELTA - 1 }, (_, index) => row(101 + index, 'user', '短消息'));
  assert.equal(shouldRefreshLedger(ledger, small), false);
  const countTriggered = [...small, row(999, 'assistant', '再增加一条')];
  assert.equal(countTriggered.length, 32);
  assert.equal(shouldRefreshLedger(ledger, countTriggered), true);

  const tokenHeavy = [row(1001, 'user', '中'.repeat(LEDGER_REFRESH_TOKEN_DELTA))];
  assert.ok(estimateLedgerRowsTokens(tokenHeavy) >= LEDGER_REFRESH_TOKEN_DELTA);
  assert.equal(shouldRefreshLedger(ledger, tokenHeavy), true);
});

test('账本模型响应兼容 Anthropic/OpenAI JSON 与 SSE 文本增量', () => {
  const json = JSON.stringify({ content: [{ type: 'text', text: '这是滚动摘要' }] });
  assert.equal(parseLedgerModelResponse(json, 'application/json'), '这是滚动摘要');

  const sse = [
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"第一段"}}',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"第二段"}}',
    'data: [DONE]',
    '',
  ].join('\n');
  assert.equal(parseLedgerModelResponse(sse, 'text/event-stream'), '第一段第二段');
});

test('本地兜底生成有重点的摘录摘要，而不是简单截取首尾', () => {
  const summary = localLedgerSummary('已有稳定事实', [
    row(201, 'user', '今天上午我们确定了 OurHome 的摘要要保留原始聊天，并记录重要决定。'),
    row(202, 'assistant', '接下来先修复上下文账本，再跑测试。'),
  ]);
  assert.match(summary, /已有稳定事实/);
  assert.match(summary, /今天上午/);
  assert.match(summary, /修复上下文账本/);
  assert.doesNotMatch(summary, /intimacy_control/);
});
