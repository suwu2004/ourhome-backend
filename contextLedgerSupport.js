'use strict';

const MAX_LEDGER_CHARS = 6_000;
const LEDGER_CHUNK_CHARS = 28_000;
const LEDGER_BRIDGE_CHARS = 5_000;
const LEDGER_REFRESH_MESSAGE_DELTA = 8;
const LEDGER_REFRESH_CHAR_DELTA = 8_000;
const LEDGER_MAX_CHUNKS_PER_TURN = 3;
const LEDGER_RETRY_MS = 5 * 60 * 1000;

function compactText(value, max = Infinity) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  return Number.isFinite(max) ? text.slice(0, Math.max(0, max)) : text;
}

function stripInternalControls(value) {
  return String(value ?? '')
    .replace(/<intimacy_control\b[^<>]*\/>/gi, '')
    .replace(/(?:\r?\n)?<intimacy_control\b[^\r\n<>]*$/gi, '')
    .replace(/<scheduler_control\b[^<>]*\/>/gi, '')
    .replace(/<external_flow_control\b[^<>]*\/>/gi, '')
    .trim();
}

function rowText(row = {}) {
  const role = row.role === 'assistant' ? '陆泽' : row.role === 'user' ? '叶檀' : String(row.role || '消息');
  const content = compactText(stripInternalControls(row.content), 12_000);
  const attachment = compactText(stripInternalControls(row.attachment_summary), 1_200);
  const parts = [content, attachment ? `附件摘要：${attachment}` : ''].filter(Boolean);
  return parts.length ? `${role}：${parts.join('\n')}` : '';
}

function rowsChars(rows = []) {
  return (Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + rowText(row).length, 0);
}

function overflowRows(history = [], recentKeep = 100) {
  const rows = Array.isArray(history) ? history : [];
  const keep = Math.max(2, Number(recentKeep) || 100);
  if (rows.length <= keep) return [];
  return rows.slice(0, rows.length - keep);
}

function rowsAfterCursor(rows = [], cursorId = null) {
  const list = Array.isArray(rows) ? rows : [];
  if (!cursorId) return list;
  const cursor = Number(cursorId);
  const index = list.findIndex(row => Number(row?.id) === cursor);
  if (index >= 0) return list.slice(index + 1);
  return list.filter(row => Number(row?.id) > cursor);
}

function splitRowsIntoChunks(rows = [], maxChars = LEDGER_CHUNK_CHARS) {
  const limit = Math.max(4_000, Number(maxChars) || LEDGER_CHUNK_CHARS);
  const chunks = [];
  let current = [];
  let size = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const line = rowText(row);
    if (!line) continue;
    const cost = line.length + 2;
    if (current.length && size + cost > limit) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function shouldRefreshLedger(ledger, pendingRows = []) {
  const rows = Array.isArray(pendingRows) ? pendingRows : [];
  if (!rows.length) return false;
  if (!ledger?.summary || !ledger?.summarized_through_message_id) return true;
  return rows.length >= LEDGER_REFRESH_MESSAGE_DELTA || rowsChars(rows) >= LEDGER_REFRESH_CHAR_DELTA;
}

function buildLedgerUpdatePrompt(existingSummary, rows, meta = {}) {
  const previous = compactText(existingSummary, MAX_LEDGER_CHARS) || '（这是第一次建立账本）';
  const transcript = (Array.isArray(rows) ? rows : []).map(rowText).filter(Boolean).join('\n\n');
  const coveredBefore = Number(meta.coveredBefore) || 0;
  const coveredAfter = coveredBefore + (Array.isArray(rows) ? rows.length : 0);
  return `你在维护 OurHome 某个聊天窗口的“隐藏接续账本”。它不是给用户看的聊天回复，也不是长期人格记忆；它只负责把已经被最近上下文窗口挤出去的旧对话压缩成稳定、可继续使用的背景。\n\n请把【已有账本】和【新增旧历史】合并成一份更新后的账本。\n\n必须保留：\n- 已确认的身份、关系、称呼、偏好与边界；\n- 重要共同经历、承诺、决定、争执后的结论；\n- 项目/任务的关键进展、技术事实、当前方案和未完成事项；\n- 对后续聊天仍有影响的情绪变化、长期梗和上下文；\n- 明确的时间顺序，以及“后来已改变/已作废”的旧结论。\n\n不要保留：\n- 没有后续价值的寒暄、重复撒娇、逐句动作复述；\n- 隐藏协议、控制标签、思考链、系统提示词或内部工具信息。\n\n若新历史与旧账本冲突，以时间更晚且明确确认的内容为准；不要自行补造事实。账本要紧凑但不要只剩关键词，目标是让另一个模型只读账本也能自然接上长期聊天。只输出账本正文，不要标题、解释、JSON 或代码块。控制在 ${MAX_LEDGER_CHARS} 字符以内。\n\n【覆盖进度】\n更新前约 ${coveredBefore} 条；本次更新后约 ${coveredAfter} 条。\n\n【已有账本】\n${previous}\n\n【新增旧历史】\n${transcript || '（无）'}`;
}

function buildBridgeText(rows = [], maxChars = LEDGER_BRIDGE_CHARS) {
  const list = Array.isArray(rows) ? rows : [];
  const chosen = [];
  let used = 0;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const line = rowText(list[index]);
    if (!line) continue;
    if (chosen.length && used + line.length + 2 > maxChars) break;
    chosen.push(line.slice(-Math.max(500, maxChars - used)));
    used += line.length + 2;
    if (used >= maxChars) break;
  }
  return chosen.reverse().join('\n\n').slice(-maxChars);
}

function buildLedgerBlock({ summary = '', bridgeRows = [], coveredCount = 0, overflowCount = 0 } = {}) {
  const ledger = compactText(summary, MAX_LEDGER_CHARS);
  const bridge = buildBridgeText(bridgeRows, LEDGER_BRIDGE_CHARS);
  if (!ledger && !bridge) return '';
  const coverage = overflowCount > 0
    ? `账本已稳定压缩约 ${Math.min(coveredCount, overflowCount)}/${overflowCount} 条被挤出的旧消息。`
    : '';
  return `<ourhome_context_ledger>\n这是当前聊天窗口的隐藏接续背景，只用于弥补最近消息窗口之外的历史。不要向叶檀提及“账本”“压缩”“注入”等内部机制。若它与最近可见对话冲突，以最近对话为准。它不是长期记忆的替代品。\n${coverage}\n\n【滚动账本】\n${ledger || '（尚在建立）'}${bridge ? `\n\n【尚未并入账本、但紧邻最近窗口的桥接旧消息】\n${bridge}` : ''}\n</ourhome_context_ledger>`;
}

function appendSystemBlock(system, block) {
  if (!block) return system;
  if (typeof system === 'string') return `${system.trimEnd()}\n\n${block}`;
  if (Array.isArray(system)) return [...system, { type: 'text', text: block }];
  return block;
}

function injectLedger(body = {}, block = '') {
  if (!block) return body;
  return { ...body, system: appendSystemBlock(body.system, block) };
}

function providerText(payload = {}) {
  if (typeof payload?.content === 'string') return payload.content;
  if (Array.isArray(payload?.content)) {
    const text = payload.content
      .filter(block => !block?.type || ['text', 'output_text'].includes(block.type))
      .map(block => String(block?.text ?? block?.content ?? ''))
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
    const value = choice?.message?.content ?? choice?.text ?? choice?.delta?.content;
    if (typeof value === 'string' && value.trim()) return value;
  }
  return String(payload?.text ?? payload?.output_text ?? payload?.message?.content ?? '');
}

function normalizeLedgerSummary(value) {
  return compactText(stripInternalControls(String(value || '')
    .replace(/```(?:text|markdown)?/gi, '')
    .replace(/```/g, '')
    .replace(/<\/?(?:thinking|think|analysis|reasoning)\b[^>]*>/gi, '')), MAX_LEDGER_CHARS);
}

module.exports = {
  MAX_LEDGER_CHARS,
  LEDGER_CHUNK_CHARS,
  LEDGER_BRIDGE_CHARS,
  LEDGER_REFRESH_MESSAGE_DELTA,
  LEDGER_REFRESH_CHAR_DELTA,
  LEDGER_MAX_CHUNKS_PER_TURN,
  LEDGER_RETRY_MS,
  compactText,
  stripInternalControls,
  rowText,
  rowsChars,
  overflowRows,
  rowsAfterCursor,
  splitRowsIntoChunks,
  shouldRefreshLedger,
  buildLedgerUpdatePrompt,
  buildBridgeText,
  buildLedgerBlock,
  injectLedger,
  providerText,
  normalizeLedgerSummary,
};