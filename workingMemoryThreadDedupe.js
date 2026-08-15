'use strict';

const THREAD_WINDOW_MS = 90 * 60 * 1000;
const RECENT_THREAD_LIMIT = 12;

const GENERIC_TOPIC_BIGRAMS = new Set([
  '叶檀', '陆泽', '今天', '现在', '晚上', '继续', '回应', '确认', '表达', '互动', '情感',
  '主动', '具体', '进行', '已经', '这个', '自己', '两人', '话题', '等待', '要求', '承诺',
  '真实', '明确', '设定', '角色', '中的', '框架', '情况', '状态', '问题', '需要',
]);

function normalizeMemoryText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

function ngrams(value, size) {
  const normalized = normalizeMemoryText(value);
  if (normalized.length < size) return new Set();
  const output = new Set();
  for (let index = 0; index <= normalized.length - size; index += 1) {
    const gram = normalized.slice(index, index + size);
    if (gram.includes('叶檀') || gram.includes('陆泽')) continue;
    if (size === 2 && GENERIC_TOPIC_BIGRAMS.has(gram)) continue;
    output.add(gram);
  }
  return output;
}

function intersectionSize(left, right) {
  if (!left.size || !right.size) return 0;
  let count = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const value of small) if (large.has(value)) count += 1;
  return count;
}

function timestampOf(mark) {
  const value = mark?.updated_at || mark?.created_at;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function sameSession(candidate, existing) {
  const left = String(candidate?.session_id || '').trim();
  const right = String(existing?.session_id || '').trim();
  return Boolean(left && right && left === right);
}

function previousMessageIds(mark) {
  const metadata = mark?.metadata && typeof mark.metadata === 'object' ? mark.metadata : {};
  return [
    mark?.message_id,
    metadata.first_message_id,
    metadata.last_message_id,
    ...(Array.isArray(metadata.merged_message_ids) ? metadata.merged_message_ids : []),
  ].map(value => String(value || '').trim()).filter(Boolean);
}

function workingMemoryThreadMatch(candidate, existing, now = Date.now()) {
  if (!candidate || !existing) return null;
  if (!['active', 'continued'].includes(String(existing.status || 'active'))) return null;

  const candidateMessageId = String(candidate.message_id || '').trim();
  if (candidateMessageId && previousMessageIds(existing).includes(candidateMessageId)) {
    return 'same-source';
  }

  const candidateSummary = normalizeMemoryText(candidate.summary);
  const existingSummary = normalizeMemoryText(existing.summary);
  if (candidateSummary && candidateSummary === existingSummary) return 'exact-summary';

  if (!sameSession(candidate, existing)) return null;
  const existingAt = timestampOf(existing);
  if (!existingAt || Math.abs(now - existingAt) > THREAD_WINDOW_MS) return null;

  const candidateTopic = normalizeMemoryText(candidate.topic);
  const existingTopic = normalizeMemoryText(existing.topic);
  if (candidateTopic.length >= 4 && candidateTopic === existingTopic) return 'same-topic';

  const topicOverlap = intersectionSize(ngrams(candidate.topic, 2), ngrams(existing.topic, 2));
  const candidateCombined = `${candidate.topic || ''}\n${candidate.summary || ''}`;
  const existingCombined = `${existing.topic || ''}\n${existing.summary || ''}`;
  const phraseOverlap = intersectionSize(ngrams(candidateCombined, 4), ngrams(existingCombined, 4));
  const detailOverlap = intersectionSize(ngrams(candidateCombined, 2), ngrams(existingCombined, 2));

  // Working memory is a rolling note, not a turn-by-turn diary. A recent thread
  // must share a distinctive phrase or several concrete details before it is
  // considered the same note. The thresholds are intentionally conservative so
  // two different subjects discussed close together remain separate memories.
  if (phraseOverlap >= 3) return 'rolling-phrase';
  if (phraseOverlap >= 1 && topicOverlap >= 2) return 'rolling-topic';
  if (topicOverlap >= 1 && detailOverlap >= 7) return 'rolling-details';
  return null;
}

function findWorkingMemoryThreadMatch(candidate, recentMarks = [], now = Date.now()) {
  const sorted = [...recentMarks].sort((left, right) => timestampOf(right) - timestampOf(left));
  for (const row of sorted) {
    const reason = workingMemoryThreadMatch(candidate, row, now);
    if (reason) return { row, reason };
  }
  return null;
}

function uniqueStrings(values, limit = 12) {
  const output = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || output.includes(text)) continue;
    output.push(text);
  }
  return output.slice(-limit);
}

function mergeWorkingMemoryThread(existing, candidate, { reason = 'rolling', now = new Date() } = {}) {
  const metadata = existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {};
  const candidateMetadata = candidate?.metadata && typeof candidate.metadata === 'object' ? candidate.metadata : {};
  const sameSource = reason === 'same-source';
  const firstMessageId = String(metadata.first_message_id || existing?.message_id || candidate?.message_id || '').trim() || null;
  const latestMessageId = String(candidate?.message_id || metadata.last_message_id || existing?.message_id || '').trim() || null;
  const mergedMessageIds = uniqueStrings([
    ...(Array.isArray(metadata.merged_message_ids) ? metadata.merged_message_ids : []),
    existing?.message_id,
    candidate?.message_id,
  ]);
  const mergedTurnCount = Math.max(1, Number(metadata.merged_turn_count) || 1) + (sameSource ? 0 : 1);

  return {
    message_id: latestMessageId,
    session_id: candidate?.session_id || existing?.session_id || null,
    role: candidate?.role || existing?.role || 'user',
    mark_date: candidate?.mark_date || existing?.mark_date,
    topic: candidate?.topic || existing?.topic || null,
    emotion: candidate?.emotion || existing?.emotion || null,
    summary: candidate?.summary || existing?.summary || null,
    tags: uniqueStrings([
      ...(Array.isArray(existing?.tags) ? existing.tags : []),
      ...(Array.isArray(candidate?.tags) ? candidate.tags : []),
    ], 8),
    importance: Math.max(Number(existing?.importance) || 1, Number(candidate?.importance) || 1),
    // The latest model decision owns whether this thread is still unfinished.
    // Using OR here would make a once-open thread stay open forever.
    should_continue: Boolean(candidate?.should_continue),
    should_remember: Boolean(existing?.should_remember || candidate?.should_remember),
    status: 'active',
    reinforcement_count: Math.max(0, Number(existing?.reinforcement_count) || 0) + (sameSource ? 0 : 1),
    updated_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    metadata: {
      ...metadata,
      ...candidateMetadata,
      working_memory_rollup: 'rolling-thread-v1',
      merge_reason: reason,
      first_message_id: firstMessageId,
      last_message_id: latestMessageId,
      merged_message_ids: mergedMessageIds,
      merged_turn_count: mergedTurnCount,
    },
  };
}

module.exports = {
  THREAD_WINDOW_MS,
  RECENT_THREAD_LIMIT,
  normalizeMemoryText,
  workingMemoryThreadMatch,
  findWorkingMemoryThreadMatch,
  mergeWorkingMemoryThread,
};
