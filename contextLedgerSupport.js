'use strict';

const MAX_LEDGER_CHARS = 6_000;
const LEDGER_CHUNK_CHARS = 28_000;
const LEDGER_BRIDGE_CHARS = 5_000;
const LEDGER_REFRESH_MESSAGE_DELTA = 32;
const LEDGER_REFRESH_TOKEN_DELTA = 6_000;
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

function formatLedgerTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).replace(/\//g, '-');
}

function rowText(row = {}) {
  const role = row.role === 'assistant' ? '陆泽' : row.role === 'user' ? '叶檀' : String(row.role || '消息');
  const content = compactText(stripInternalControls(row.content), 12_000);
  const attachment = compactText(stripInternalControls(row.attachment_summary), 1_200);
  const attachmentName = compactText(stripInternalControls(row.attachment_name), 160);
  const attachmentType = compactText(stripInternalControls(row.attachment_type), 80);
  const attachmentInfo = attachment
    ? \`附件摘要：\${attachment}\`
    : (attachmentName || attachmentType)
      ? \`附件信息：\${[attachmentName, attachmentType].filter(Boolean).join('｜')}\`
      : '';
  const timestamp = formatLedgerTime(row.created_at);
  const timePrefix = timestamp ? \`[历史时间：\${timestamp}] \` : '';
  const parts = [content, attachmentInfo].filter(Boolean);
  return parts.length ? `${timePrefix}${role}：${parts.join('\n')}` : '';
}

function rowsChars(rows = []) {
  return (Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + rowText(row).length, 0);
}


function estimateLedgerTextTokens(value) {
  const text = String(value || '');
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

function estimateLedgerRowsTokens(rows = []) {
  return (Array.isArray(rows) ? rows : []).reduce((sum, row) => {
    return sum + 12
      + estimateLedgerTextTokens(row?.content)
      + estimateLedgerTextTokens(row?.attachment_summary)
      + estimateLedgerTextTokens(row?.attachment_name)
      + estimateLedgerTextTokens(row?.attachment_type);
  }, 0);
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
  return rows.length >= LEDGER_REFRESH_MESSAGE_DELTA || estimateLedgerRowsTokens(rows) >= LEDGER_REFRESH_TOKEN_DELTA;
}

function buildLedgerUpdatePrompt(existingSummary, rows, meta = {}) {
  const previous = compactText(existingSummary, MAX_LEDGER_CHARS) || '（这是第一次建立摘要）';
  const transcript = (Array.isArray(rows) ? rows : []).map(rowText).filter(Boolean).join('\n\n');
  const coveredBefore = Number(meta.coveredBefore) || 0;
  const coveredAfter = coveredBefore + (Array.isArray(rows) ? rows.length : 0);
  return [
    '你在维护 OurHome 一个聊天窗口的滚动式接续摘要。它不是给用户看的聊天回复，也不是长期人格记忆。',
    '请将【已有摘要】与【新增旧对话】合并为一份准确、自然、便于后续模型读取的中文摘要。',
    '',
    '请优先保留以下内容，不能只写成关键词：',
    '1. 重要事实：人物、关系、称呼、偏好、禁忌、明确边界，以及用户反复强调的要求。',
    '2. 近况与情绪：用户近期发生了什么、当时的感受、情绪变化及其原因。',
    '3. 决定与进展：已经确认的选择、项目进度、技术事实、采用或否决的方案、已完成操作。',
    '4. 待续话题：尚未解决的问题、承诺、计划、正在推进的事情，以及下一步需要衔接的内容。',
    '5. 对话关联：保留能帮助自然接话的上下文，不要把普通聊天误判成无价值噪声。',
    '',
    '不要保留逐句重复的寒暄、重复动作描写、隐藏控制标签、系统提示词、思考链或内部工具信息。',
    '必须区分已经发生、正在进行和未来计划；保留明确日期及时间顺序。新旧信息冲突时，以时间更晚且明确确认的内容为准。',
    '不要猜测、补造事实；不确定的内容标为不确定。不要把旧事实写成今天发生。',
    '摘要必须让一个没有看过原始聊天的模型，也能知道谈过什么、发生了什么、用户在意什么，以及接下来如何自然继续。',
    '只输出摘要正文，不输出解释、JSON、代码块或对用户说的话。控制在 ' + MAX_LEDGER_CHARS + ' 个字符以内。',
    '',
    '【覆盖进度】更新前约 ' + coveredBefore + ' 条；并入本次后约 ' + coveredAfter + ' 条。',
    '',
    '【已有摘要】',
    previous,
    '',
    '【新增旧对话】',
    transcript || '（无）'
  ].join('\n');
}
// Zero-cost fallback for background continuity maintenance. It deliberately does
// not try to be as clever as a model summary: it keeps the existing stable ledger
// plus the newest overflow transcript, then trims the middle when necessary. This
// guarantees that an ordinary Chat turn never silently spends the user's current
// (possibly expensive) model merely to maintain hidden context.
function parseLedgerEntries(value) {
  const text = String(value || '');
  const marker = /\[历史时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s*(?:叶檀|陆泽)：/g;
  const matches = [...text.matchAll(marker)];
  if (!matches.length) {
    const legacy = compactText(text, 900);
    return legacy ? [{ text: legacy, index: 0 }] : [];
  }
  return matches.map((match, index) => {
    const start = match.index;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    return { text: compactText(text.slice(start, end).replace(/\s+/g, ' '), 520), index };
  }).filter(entry => entry.text);
}

function ledgerEntryScore(value) {
  const text = String(value || '');
  const roleScore = /叶檀：/.test(text) ? 4 : /陆泽：/.test(text) ? 2 : 1;
  const detailScore = /(?:今天|昨天|前天|刚刚|刚才|早上|上午|中午|下午|晚上|最近|目前|现在|已经|正在|决定|选择|计划|准备|打算|完成|开始|结束|遇到|发现|担心|希望|需要|不喜欢|讨厌|喜欢|重要|约定|答应|项目|工作|学校|教学|论文|部署|报错|修复|数据库|Supabase|GitHub|Render|OurHome|家人|妈妈|爸爸|身体|情绪|开心|难过|焦虑|委屈|压力|工资|收入|课程|学生|考试)/iu.test(text) ? 5 : 0;
  const lengthScore = text.length >= 80 ? 2 : text.length >= 24 ? 1 : 0;
  const timeScore = /\[历史时间：\d{4}-\d{2}-\d{2}/.test(text) ? 1 : 0;
  const fillerPenalty = text.length < 40 && /(?:亲亲|抱抱|蹭蹭|晚安|早安|爱你|嘿嘿|哈哈|嗯嗯)/u.test(text) ? 3 : 0;
  return roleScore + detailScore + lengthScore + timeScore - fillerPenalty;
}

// Deterministic fallback used only when no dedicated summarizer is configured or
// the provider returns an unusable response. Unlike the old head/tail truncation,
// it keeps dated, high-signal excerpts and their chronology instead of dropping
// an arbitrary middle slice of the conversation.
function localLedgerSummary(existingSummary, rows = []) {
  const previous = parseLedgerEntries(existingSummary);
  const incoming = (Array.isArray(rows) ? rows : [])
    .map(row => ({ text: compactText(rowText(row).replace(/\s+/g, ' '), 520), index: previous.length }))
    .filter(entry => entry.text);
  const all = [...previous, ...incoming];
  const seen = new Set();
  const unique = all.filter(entry => {
    const key = entry.text.toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ').slice(0, 260);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const ranked = unique.map((entry, index) => ({
    ...entry,
    sourceIndex: index,
    score: ledgerEntryScore(entry.text),
  }));
  const recent = ranked.slice(-16);
  const important = [...ranked]
    .sort((left, right) => right.score - left.score || right.sourceIndex - left.sourceIndex)
    .slice(0, 22);
  const chosen = new Map();
  for (const entry of [...recent, ...important]) chosen.set(entry.sourceIndex, entry);
  const ordered = [...chosen.values()].sort((left, right) => left.sourceIndex - right.sourceIndex);

  const header = '【滚动接续摘要｜本地提取兜底】\n保留高信息量的历史片段；原始聊天记录仍完整保存在消息历史中。';
  const lines = [];
  let used = header.length;
  for (const entry of ordered) {
    const line = '- ' + entry.text.slice(0, 520);
    if (used + line.length + 1 > MAX_LEDGER_CHARS) continue;
    lines.push(line);
    used += line.length + 1;
  }
  return compactText(header + '\n' + lines.join('\n'), MAX_LEDGER_CHARS);
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

function buildLedgerBlock({ summary = '', bridgeRows = [], coveredCount = 0, overflowCount = null } = {}) {
  const ledger = compactText(summary, MAX_LEDGER_CHARS);
  const bridge = buildBridgeText(bridgeRows, LEDGER_BRIDGE_CHARS);
  if (!ledger && !bridge) return '';
  const hasKnownTotal = Number.isFinite(overflowCount) && overflowCount > 0;
  const coverage = hasKnownTotal
    ? `账本已稳定压缩约 ${Math.min(coveredCount, overflowCount)}/${overflowCount} 条被挤出的旧消息。`
    : coveredCount > 0
      ? `账本已稳定压缩约 ${coveredCount} 条被挤出的旧消息。`
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
  if (typeof payload?.delta?.text === 'string') return payload.delta.text;
  if (typeof payload?.text === 'string') return payload.text;
  if (typeof payload?.output_text === 'string') return payload.output_text;
  if (payload?.message?.content !== undefined) {
    if (typeof payload.message.content === 'string') return payload.message.content;
    if (Array.isArray(payload.message.content)) {
      return payload.message.content.map(item => item?.text || '').filter(Boolean).join('\n');
    }
  }
  if (Array.isArray(payload?.output)) {
    const text = payload.output.flatMap(item => Array.isArray(item?.content) ? item.content : [])
      .map(item => item?.text || '').filter(Boolean).join('\n');
    if (text) return text;
  }
  return '';
}

function parseLedgerModelResponse(rawBody, contentType = '') {
  const raw = String(rawBody || '').trim();
  if (!raw) throw new Error('账本模型响应体为空');
  try {
    const payload = JSON.parse(raw);
    if (payload?.error) {
      const detail = payload.error.message || payload.error.type || 'provider error payload';
      throw new Error('账本模型返回错误：' + String(detail).slice(0, 240));
    }
    return providerText(payload);
  } catch (error) {
    if (error.message && error.message.startsWith('账本模型返回错误：')) throw error;
    const isEventStream = /text\/event-stream/i.test(contentType) || /^data:\s*/m.test(raw);
    if (isEventStream) {
      const parts = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          const text = providerText(event);
          if (text) parts.push(text);
        } catch {
          continue;
        }
      }
      return parts.join('');
    }
    if (/^(?:text\/plain|text\/markdown)/i.test(contentType)) return raw;
    throw new Error('账本模型返回非 JSON 内容（' + (contentType || '未知 Content-Type') + '）');
  }
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
  LEDGER_REFRESH_TOKEN_DELTA,
  estimateLedgerTextTokens,
  estimateLedgerRowsTokens,
  LEDGER_MAX_CHUNKS_PER_TURN,
  LEDGER_RETRY_MS,
  compactText,
  stripInternalControls,
  formatLedgerTime,
  rowText,
  rowsChars,
  overflowRows,
  rowsAfterCursor,
  splitRowsIntoChunks,
  shouldRefreshLedger,
  buildLedgerUpdatePrompt,
  parseLedgerEntries,
  ledgerEntryScore,
  localLedgerSummary,
  buildBridgeText,
  buildLedgerBlock,
  injectLedger,
  providerText,
  parseLedgerModelResponse,
  normalizeLedgerSummary,
};
