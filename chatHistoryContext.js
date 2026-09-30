'use strict';

const DEFAULT_CONTEXT_RADIUS = 120;
const MIN_CONTEXT_RADIUS = 40;
const MAX_CONTEXT_RADIUS = 240;

function normalizeRadius(value, fallback = DEFAULT_CONTEXT_RADIUS) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(MIN_CONTEXT_RADIUS, Math.min(MAX_CONTEXT_RADIUS, parsed));
}

function sortMessages(rows, ascending = true) {
  return [...(rows || [])].sort((left, right) => {
    const byTime = Date.parse(left?.created_at || '') - Date.parse(right?.created_at || '');
    if (Number.isFinite(byTime) && byTime !== 0) return ascending ? byTime : -byTime;
    const leftId = Number(left?.id || 0);
    const rightId = Number(right?.id || 0);
    return ascending ? leftId - rightId : rightId - leftId;
  });
}

function contextCursor(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  return {
    before: rows[0]?.created_at || '',
    after: rows[rows.length - 1]?.created_at || '',
  };
}

async function loadMessageContext(supabase, {
  sessionId,
  messageId,
  before = DEFAULT_CONTEXT_RADIUS,
  after = DEFAULT_CONTEXT_RADIUS,
} = {}) {
  const safeBefore = normalizeRadius(before);
  const safeAfter = normalizeRadius(after);

  const { data: target, error: targetError } = await supabase.from('messages')
    .select('*')
    .eq('id', messageId)
    .eq('session_id', sessionId)
    .eq('visible', true)
    .maybeSingle();
  if (targetError) throw targetError;
  if (!target) {
    const error = new Error('找不到这条聊天消息');
    error.status = 404;
    throw error;
  }

  const [olderResult, newerResult] = await Promise.all([
    supabase.from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .lt('created_at', target.created_at)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(safeBefore),
    supabase.from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .gt('created_at', target.created_at)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(safeAfter),
  ]);
  if (olderResult.error) throw olderResult.error;
  if (newerResult.error) throw newerResult.error;

  const older = sortMessages(olderResult.data || [], true);
  const newer = sortMessages(newerResult.data || [], true);
  const messages = [...older, target, ...newer];
  const cursor = contextCursor(messages);

  return {
    messages,
    targetId: String(target.id),
    hasOlder: (olderResult.data || []).length >= safeBefore,
    hasNewer: (newerResult.data || []).length >= safeAfter,
    nextBefore: cursor.before,
    nextAfter: cursor.after,
  };
}

module.exports = {
  DEFAULT_CONTEXT_RADIUS,
  MIN_CONTEXT_RADIUS,
  MAX_CONTEXT_RADIUS,
  normalizeRadius,
  contextCursor,
  loadMessageContext,
};
