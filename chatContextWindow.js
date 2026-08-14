'use strict';

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

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

function selectRecentHistory(history = [], options = {}) {
  const list = Array.isArray(history) ? history : [];
  const maxRounds = normalizePositiveInteger(options.maxRounds, 20, 500);
  const maxMessages = Math.max(2, maxRounds * 2);
  const byRounds = list.slice(-maxMessages);
  const maxTokens = normalizePositiveInteger(options.maxTokens, 0, 1_000_000);
  if (!maxTokens || !byRounds.length) return byRounds;

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
  return byRounds.slice(start);
}

module.exports = {
  estimateTextTokens,
  estimateMessageTokens,
  selectRecentHistory,
};
