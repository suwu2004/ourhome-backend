'use strict';

// Compatibility helpers retained for older imports/tests. Theater reply length
// is a minimum/target setting, never a hard maximum. The active runtime uses
// theaterReplyLengthGuardPatch to provide the one-call provider budget.
const MAX_CACHE = 1200;
const lengthByAnswer = new Map();

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('\n');
}

function requestedReplyChars(body) {
  const text = `${textOf(body?.system)}\n${textOf(body?.messages?.at(-1)?.content)}`;
  const match = text.match(/(?:完整回复至少|最低长度约为|当前设置的最低长度约为|目标长度约为)\s*(\d+)\s*(?:个中文字符|字)/u);
  return match ? Number(match[1]) : 0;
}

function remember(answer, limit) {
  const key = String(answer || '').trim();
  const value = Number(limit);
  if (!key || !Number.isFinite(value) || value <= 0) return;
  lengthByAnswer.delete(key);
  lengthByAnswer.set(key, Math.round(value));
  while (lengthByAnswer.size > MAX_CACHE) lengthByAnswer.delete(lengthByAnswer.keys().next().value);
}

function lookup(answer) {
  return lengthByAnswer.get(String(answer || '').trim()) || 0;
}

function trimAtNaturalBoundary(text, maxChars) {
  const value = String(text || '');
  if (!maxChars || value.length <= maxChars) return value;
  const cut = value.slice(0, maxChars);
  const boundary = Math.max(
    cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'),
    cut.lastIndexOf('；'), cut.lastIndexOf('…'), cut.lastIndexOf('\n'), cut.lastIndexOf('!'), cut.lastIndexOf('?'), cut.lastIndexOf(';'),
  );
  if (boundary >= Math.max(1, Math.floor(maxChars * 0.72))) return cut.slice(0, boundary + 1).trimEnd();
  return cut.trimEnd();
}

// Deliberately does not truncate. `min_reply_chars` is a minimum/target, not a
// maximum; cutting here was the source of replies ending mid-sentence.
function capAssistantInsert(body) {
  return body;
}

module.exports = {
  requestedReplyChars,
  trimAtNaturalBoundary,
  capAssistantInsert,
  remember,
  lookup,
};
