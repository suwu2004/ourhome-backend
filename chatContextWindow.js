'use strict';

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
const HISTORY_TIMELINE_MARKER_RE = /(?:^|\n)\s*\[历史时间[：:]\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/g;

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

// 最近三天的生活上下文单独保留，避免“今天聊得太多”把“昨天中午吃了什么”挤出上下文。
function selectRecentLifeHistory(history = [], options = {}) {
  const list = Array.isArray(history) ? history : [];
  if (!list.length) return [];
  const recentHours = normalizePositiveInteger(options.recentHours, 72, 168);
  const maxMessages = normalizePositiveInteger(options.maxMessages, 80, 160);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const recent = list.filter(message => isWithinRecentHours(message?.created_at, now, recentHours));
  if (!recent.length) return [];
  return annotateHistoryTimeline(recent.slice(-maxMessages));
}

function selectRecentHistory(history = [], options = {}) {
  const list = Array.isArray(history) ? history : [];
  // 原先默认只保留20轮，长聊中日常事实很容易在几小时内掉出窗口。
  // 扩到48轮仍然是有界的；最近三天则由 selectRecentLifeHistory 单独兜底。
  const maxRounds = normalizePositiveInteger(options.maxRounds, 48, 500);
  const maxMessages = Math.max(2, maxRounds * 2);
  const byRounds = list.slice(-maxMessages);
  const maxTokens = normalizePositiveInteger(options.maxTokens, 0, 1_000_000);
  if (!maxTokens || !byRounds.length) return annotateHistoryTimeline(byRounds);

  const minMessages = Math.max(1, Math.min(byRounds.length, normalizePositiveInteger(options.minMessages, 2, 8)));
  let start = byRounds.length;
  let estimatedTokens = 0;
  while (start > 0) {
    const nextCost = estimateMessageTokens(byRounds[start - 1]);
    const kept = byRounds.length - start;
    if (kept >= minMessages && estimatedTokens + nextCost > maxTokens) break;
    start -= 1;
    estimatedTokens += nextCost;
  }
  return annotateHistoryTimeline(byRounds.slice(start));
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
