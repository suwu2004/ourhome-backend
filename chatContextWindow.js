'use strict';

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
const HISTORY_TIMELINE_MARKER_RE = /(?:^|\n)\s*\[历史时间[：:]\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/g;
const RECENT_LIFE_FACT_RE = /(?:今天|昨天|前天|刚才|刚刚|早上|上午|中午|下午|晚上|昨晚|今早|今晚|早餐|早饭|午饭|午餐|晚饭|晚餐|吃了|喝了|睡了|起床|回家|出门|上班|下班|上课|下课|买了|去了|回来|到家|在家|路上|明天|后天)/u;
const RECENT_LIFE_CONTEXT_HOURS = 72;
const RECENT_LIFE_FACT_MESSAGES = 8;

function normalizePositiveInteger(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

function estimateTextTokens(value) {
  const text = String(value || '');
  if (!text) return 0;
  const cjk = (text.match(CJK_RE) || []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

function estimateMessageTokens(message = {}) {
  const attachmentText = [message.attachment_name, message.attachment_summary]
    .filter(Boolean)
    .join('\n');
  return 16 + estimateTextTokens(message.content) + estimateTextTokens(attachmentText);
}

function formatTimelineStamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).replace(/\//g, '-');
}

function stripHistoryTimelineAnnotations(value) {
  if (typeof value !== 'string' || !value) return value;
  return value.replace(HISTORY_TIMELINE_MARKER_RE, (match, offset) => offset === 0 ? '' : '\n');
}

function annotateHistoryTimeline(messages = []) {
  return messages.map(message => {
    const stamp = formatTimelineStamp(message.created_at);
    if (!stamp) return { ...message };
    const cleanContent = stripHistoryTimelineAnnotations(String(message.content || ''));
    return { ...message, content: `[历史时间：${stamp}]\n${cleanContent}` };
  });
}

function shanghaiDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function isWithinRecentHours(createdAt, now, recentHours) {
  const stamp = new Date(createdAt).getTime();
  if (!Number.isFinite(stamp)) return false;
  return stamp >= now - (recentHours * 60 * 60 * 1000);
}

function isExplicitRecentLifeFact(message = {}) {
  return message?.role === 'user' && RECENT_LIFE_FACT_RE.test(String(message?.content || ''));
}

function selectRecentLifeHistory(history = [], options = {}) {
  const list = Array.isArray(history) ? history : [];
  if (!list.length) return [];
  const recentHours = normalizePositiveInteger(options.recentHours, RECENT_LIFE_CONTEXT_HOURS, 168);
  const maxMessages = normalizePositiveInteger(options.maxMessages, 80, 160);
  const factMessages = normalizePositiveInteger(options.factMessages, Math.min(RECENT_LIFE_FACT_MESSAGES, maxMessages), 24);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const recent = list.filter(message => isWithinRecentHours(message?.created_at, now, recentHours));
  if (!recent.length) return [];
  const recentSlice = recent.slice(-maxMessages);
  const factCandidates = recent.filter(isExplicitRecentLifeFact).slice(-factMessages);
  const ids = new Set(recentSlice.map(message => message?.id).filter(Boolean));
  const extras = factCandidates.filter(message => message?.id && !ids.has(message.id));
  return annotateHistoryTimeline([...recentSlice, ...extras]);
}

function selectRecentHistory(history = [], options = {}) {
  const list = Array.isArray(history) ? history : [];
  const maxRounds = normalizePositiveInteger(options.maxRounds, 48, 500);
  const maxMessages = Math.max(2, maxRounds * 2);
  const maxTokens = normalizePositiveInteger(options.maxTokens, 0, 1_000_000);
  const minMessages = Math.max(1, Math.min(list.length, normalizePositiveInteger(options.minMessages, 2, 8)));

  // First keep the normal chronological window. Recent-life messages are protected only
  // after this selection, so they never steal budget from the core recent conversation.
  let selected = list.slice(-maxMessages);
  const now = Date.now();
  const recentFacts = list
    .filter(message => isWithinRecentHours(message?.created_at, now, RECENT_LIFE_CONTEXT_HOURS))
    .filter(isExplicitRecentLifeFact)
    .slice(-RECENT_LIFE_FACT_MESSAGES);
  const ids = new Set(selected.map(message => message?.id).filter(Boolean));
  const lifeExtras = recentFacts.filter(message => message?.id && !ids.has(message.id));
  if (lifeExtras.length) {
    selected = [...selected, ...lifeExtras].sort((a, b) => {
      const at = new Date(a?.created_at || 0).getTime();
      const bt = new Date(b?.created_at || 0).getTime();
      if (at !== bt) return at - bt;
      return String(a?.id || '').localeCompare(String(b?.id || ''));
    });
  }

  if (!maxTokens || !selected.length) return annotateHistoryTimeline(selected);

  const extraIds = new Set(lifeExtras.map(message => message?.id).filter(Boolean));
  let total = selected.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

  // Trim oldest ordinary history first. Never delete a protected recent-life fact while
  // there is ordinary history left to trim. This avoids the previous double-budget logic
  // where normal history was reduced up front and then life facts were trimmed again.
  for (let index = 0; index < selected.length && total > maxTokens; index += 1) {
    const message = selected[index];
    if (extraIds.has(message?.id)) continue;
    const remainingOrdinary = selected.slice(index + 1).filter(item => !extraIds.has(item?.id)).length;
    if (remainingOrdinary < minMessages) continue;
    total -= estimateMessageTokens(message);
    selected[index] = null;
  }
  selected = selected.filter(Boolean);

  // If the budget is still exceeded, only then trim the oldest protected facts.
  for (let index = 0; index < selected.length && total > maxTokens; index += 1) {
    if (!extraIds.has(selected[index]?.id)) continue;
    total -= estimateMessageTokens(selected[index]);
    selected[index] = null;
  }
  return annotateHistoryTimeline(selected.filter(Boolean));
}

module.exports = {
  estimateTextTokens,
  estimateMessageTokens,
  formatTimelineStamp,
  stripHistoryTimelineAnnotations,
  annotateHistoryTimeline,
  shanghaiDateKey,
  selectRecentLifeHistory,
  selectRecentHistory,
};