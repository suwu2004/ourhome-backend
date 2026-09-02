'use strict';

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
const HISTORY_TIMELINE_MARKER_RE = /(?:^|\n)\s*\[历史时间[：:]\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/g;
const RECENT_LIFE_FACT_RE = /(?:今天|昨天|前天|刚才|刚刚|早上|上午|中午|下午|晚上|昨晚|今早|今晚|早餐|早饭|午饭|午餐|晚饭|晚餐|吃了|喝了|睡了|起床|回家|出门|上班|下班|上课|下课|买了|去了|回来|到家|在家|路上|明天|后天)/u;
const RECENT_LIFE_CONTEXT_HOURS = 72;
const RECENT_LIFE_FACT_MESSAGES = 8;
const RECENT_LIFE_TOKEN_BUDGET = 1600;

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
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
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
    return {
      ...message,
      content: `[历史时间：${stamp}]\n${cleanContent}`,
    };
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
  if (message?.role !== 'user') return false;
  return RECENT_LIFE_FACT_RE.test(String(message?.content || ''));
}

// 最近三天的生活上下文单独保留，避免“今天聊得太多”把“昨天中午吃了什么”挤出上下文。
// 除了最新一小段原始生活对话，再从候选区挑出用户明确说过的日常事实；这样“昨天午饭”
// 即使夹在大量项目聊天中，也不会因为只取最后24条而直接消失。
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
  const factCandidates = recent
    .filter(isExplicitRecentLifeFact)
    .slice(-factMessages);
  const ids = new Set(recentSlice.map(message => message?.id).filter(Boolean));
  const extras = factCandidates.filter(message => message?.id && !ids.has(message.id));
  return annotateHistoryTimeline([...recentSlice, ...extras]);
}

function selectRecentHistory(history = [], options = {}) {
  const list = Array.isArray(history) ? history : [];
  // 原先默认只保留20轮，长聊中日常事实很容易在几小时内掉出窗口。
  // 扩到48轮仍然是有界的；最近三天的明确生活事实再从候选历史中单独兜底。
  const maxRounds = normalizePositiveInteger(options.maxRounds, 48, 500);
  const maxMessages = Math.max(2, maxRounds * 2);
  const maxTokens = normalizePositiveInteger(options.maxTokens, 0, 1_000_000);
  const minMessages = Math.max(1, Math.min(list.length, normalizePositiveInteger(options.minMessages, 2, 8)));

  let byRounds = list.slice(-maxMessages);
  const now = Date.now();
  const recentFacts = list
    .filter(message => isWithinRecentHours(message?.created_at, now, RECENT_LIFE_CONTEXT_HOURS))
    .filter(isExplicitRecentLifeFact)
    .slice(-RECENT_LIFE_FACT_MESSAGES);
  const ids = new Set(byRounds.map(message => message?.id).filter(Boolean));
  const lifeExtras = recentFacts.filter(message => message?.id && !ids.has(message.id));

  if (lifeExtras.length) {
    byRounds = [...byRounds, ...lifeExtras].sort((a, b) => {
      const at = new Date(a?.created_at || 0).getTime();
      const bt = new Date(b?.created_at || 0).getTime();
      if (at !== bt) return at - bt;
      return String(a?.id || '').localeCompare(String(b?.id || ''));
    });
  }

  if (!maxTokens || !byRounds.length) return annotateHistoryTimeline(byRounds);

  // 最近生活事实最多占约1600 tokens，给它留出明确预算；这样即使普通历史已经很长，
  // “昨天午饭”这类事实也不会在最终 prompt 裁剪时全部消失。
  const extraIds = new Set(lifeExtras.map(message => message?.id).filter(Boolean));
  const normalTokenBudget = Math.max(1, maxTokens - (lifeExtras.length ? RECENT_LIFE_TOKEN_BUDGET : 0));
  let start = byRounds.length;
  let estimatedTokens = 0;
  while (start > 0) {
    const message = byRounds[start - 1];
    if (extraIds.has(message?.id)) {
      start -= 1;
      continue;
    }
    const nextCost = estimateMessageTokens(message);
    const keptNormal = byRounds.length - start - [...extraIds].filter(id => byRounds.slice(start).some(item => item?.id === id)).length;
    if (keptNormal >= minMessages && estimatedTokens + nextCost > normalTokenBudget) break;
    start -= 1;
    estimatedTokens += nextCost;
  }

  let selected = byRounds.slice(start);
  if (lifeExtras.length) {
    // 若生活事实自身超过预算，只从最旧的事实开始淘汰，保留最新事实。
    let total = selected.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    for (let index = 0; index < selected.length && total > maxTokens; index += 1) {
      if (!extraIds.has(selected[index]?.id)) continue;
      total -= estimateMessageTokens(selected[index]);
      selected[index] = null;
    }
    selected = selected.filter(Boolean);
  }
  return annotateHistoryTimeline(selected);
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
