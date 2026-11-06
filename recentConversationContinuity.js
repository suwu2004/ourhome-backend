'use strict';

const DEFAULT_OPTIONS = Object.freeze({
  maxMessages: 10,
  maxMessageChars: 340,
  maxTotalChars: 3_800,
  maxFactAnchors: 4,
  maxFactMessageChars: 320,
  maxFactTotalChars: 1_200,
});
const RECENT_FACT_WINDOW_MS = 72 * 60 * 60 * 1000;
const RECENT_FACT_RE = /(?:早餐|早饭|午饭|午餐|晚饭|晚餐|吃了|吃完|吃饱了|喝了|喝完了|睡了|起床|回家|到家|出门|上班|下班|上课|下课|买了|去了|回来|在路上|办公室老师|我(?:吃|喝|睡|起床|回家|到家|出门|上班|下班|上课|下课|买|去|请|回))/u;
const FUTURE_PLAN_RE = /(?:明天|后天|下周|周末|准备|打算|计划|可能会|应该会)/u;
const CORRECTION_RE = /(?:更正|纠正|准确地说|我说的是|我刚才说的是|我刚刚说的是|不是[^。！？]{0,36}(?:是|而是)|应该是|改成)/u;

function compact(value) {
  return String(value ?? '')
    .replace(/<intimacy_control\b[^<>]*\/?>/gi, '')
    .replace(/<scheduler_control\b[^<>]*\/?>/gi, '')
    .replace(/<external_flow_control\b[^<>]*\/?>/gi, '')
    .replace(/^\[历史时间[：:]\s*[^\]]+\]\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipText(value, maxChars) {
  const text = compact(value);
  if (text.length <= maxChars) return text;
  const head = Math.max(1, Math.floor(maxChars * 0.78));
  const tail = Math.max(0, maxChars - head - 8);
  return text.slice(0, head) + '……[略]……' + (tail ? text.slice(-tail) : '');
}

function timeLabel(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date).replace(/\//g, '-');
}

function messageKey(row) {
  if (row?.id !== undefined && row?.id !== null) return 'id:' + String(row.id);
  return [row?.role || '', row?.created_at || '', compact(row?.content)].join('|');
}

function isRecentUserFact(row, now) {
  if (row?.role !== 'user') return false;
  const content = compact(row.content);
  if (!content || FUTURE_PLAN_RE.test(content) || !RECENT_FACT_RE.test(content)) return false;
  const stamp = new Date(row.created_at).getTime();
  return Number.isFinite(stamp) && stamp <= now && stamp >= now - RECENT_FACT_WINDOW_MS;
}

function renderLine(row, maxChars) {
  const role = row.role === 'user' ? '叶檀' : '陆泽';
  const time = timeLabel(row.created_at);
  const id = row.id === undefined || row.id === null ? '' : '消息 #' + String(row.id).slice(0, 32);
  const metadata = [time, id].filter(Boolean).join('｜');
  const content = clipText(row.content, maxChars);
  const attachment = compact(row.attachment_summary || row.attachment_name);
  const detail = [content, attachment ? '【附件信息】' + clipText(attachment, 180) : ''].filter(Boolean).join(' ');
  const correction = row.role === 'user' && CORRECTION_RE.test(content) ? '【用户明确更正，优先于此前冲突说法】' : '';
  return '- ' + (metadata ? '[' + metadata + '] ' : '') + correction + role + '：' + detail;
}

function buildRecentConversationContinuityBlock(history = [], options = {}) {
  const maxMessages = Math.max(2, Math.min(20, Number(options.maxMessages) || DEFAULT_OPTIONS.maxMessages));
  const maxMessageChars = Math.max(120, Math.min(800, Number(options.maxMessageChars) || DEFAULT_OPTIONS.maxMessageChars));
  const maxTotalChars = Math.max(800, Math.min(6_000, Number(options.maxTotalChars) || DEFAULT_OPTIONS.maxTotalChars));
  const maxFactAnchors = Math.max(0, Math.min(8, Number(options.maxFactAnchors ?? DEFAULT_OPTIONS.maxFactAnchors)));
  const maxFactMessageChars = Math.max(160, Math.min(600, Number(options.maxFactMessageChars) || DEFAULT_OPTIONS.maxFactMessageChars));
  const maxFactTotalChars = Math.max(0, Math.min(2_400, Number(options.maxFactTotalChars ?? DEFAULT_OPTIONS.maxFactTotalChars)));
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();

  const source = (Array.isArray(history) ? history : [])
    .filter(row => row && (row.role === 'user' || row.role === 'assistant'))
    .filter(row => compact(row.content) || compact(row.attachment_summary) || compact(row.attachment_name));

  if (!source.length) return '';

  const recent = source.slice(-maxMessages);
  const recentKeys = new Set(recent.map(messageKey));
  // selectRecentHistory protects recent-life statements even when they fall
  // outside the ordinary message/token window. Surface those user-authored
  // facts in a compact index so the model does not have to rediscover them
  // among a large mixed-role transcript.
  const factCandidates = source
    .filter(row => isRecentUserFact(row, now))
    .filter(row => !recentKeys.has(messageKey(row)))
    .slice(-maxFactAnchors);

  const factLines = [];
  let usedFacts = 0;
  for (let index = factCandidates.length - 1; index >= 0; index -= 1) {
    const line = renderLine(factCandidates[index], maxFactMessageChars);
    if (usedFacts + line.length + 1 > maxFactTotalChars) continue;
    factLines.push(line);
    usedFacts += line.length + 1;
  }
  factLines.reverse();

  const rendered = [];
  let used = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const line = renderLine(recent[index], maxMessageChars);
    if (used + line.length + 1 > maxTotalChars) continue;
    rendered.push(line);
    used += line.length + 1;
  }

  if (!rendered.length && !factLines.length) return '';
  rendered.reverse();
  const sections = [
    '【最近对话连续性摘录｜接话前必须核对】',
    '以下原始消息按时间正序排列。用户原话是事实来源；陆泽的猜测不能替代用户确认。',
    '1. 先核对最近几轮已经明确出现的事实；用户已经回答过的信息，不要换个说法再问一次。',
    '2. 用户说“吃饱了、喝完了、到家了、弄好了、继续”等承接句时，先回看最近摘录和事实锚点中的相关细节，再自然接话。',
    '3. 用户后续明确更正优先于更早说法；助手自己的猜测不得升级成用户事实。',
    '4. 只有原始对话确实没有答案时，才询问缺失的信息；不要用宽泛问题让用户重复刚讲过的内容。',
  ];
  if (factLines.length) {
    sections.push(
      '【近 72 小时用户事实锚点｜较早的用户原话】',
      '这些是用户本人较早说过、但不在下面最近消息窗口里的生活事实。它们只作为检索线索，不自动代表当前状态；出现后续更正时，以更新的用户原话为准。',
      ...factLines,
    );
  }
  if (rendered.length) sections.push('【最近原始消息】', ...rendered);
  return sections.join('\n');
}

module.exports = { buildRecentConversationContinuityBlock, clipText };
