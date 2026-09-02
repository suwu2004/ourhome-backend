'use strict';

const { selectRecentHistory } = require('./chatContextWindow');

const MAX_CONTEXT_ROUNDS = 500;
const DEFAULT_CONTEXT_ROUNDS = 48;
const MESSAGE_COLUMNS = 'id, role, content, attachment_url, attachment_type, attachment_name, attachment_summary, reasoning_content, input_tokens, output_tokens, created_at';

function normalizeContextRounds(value, fallback = DEFAULT_CONTEXT_ROUNDS) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_CONTEXT_ROUNDS, parsed);
}

function recentHistoryCandidateLimit({ maxRounds, extraRows = 0 } = {}) {
  const rounds = normalizeContextRounds(maxRounds);
  const extra = Math.max(0, Math.min(8, Number.parseInt(extraRows, 10) || 0));
  return rounds * 2 + extra;
}

async function loadVisibleHistoryCandidates(supabase, sessionId, options = {}) {
  if (!supabase || !sessionId) return [];
  const columns = String(options.columns || MESSAGE_COLUMNS);
  const limit = recentHistoryCandidateLimit(options);
  const { data, error } = await supabase.from('messages')
    .select(columns)
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return [...(data || [])].reverse();
}

async function loadRecentVisibleHistory(supabase, sessionId, options = {}) {
  const candidates = await loadVisibleHistoryCandidates(supabase, sessionId, options);
  return selectRecentHistory(candidates, {
    maxRounds: options.maxRounds,
    maxTokens: options.maxTokens,
    minMessages: options.minMessages,
  });
}

module.exports = {
  MAX_CONTEXT_ROUNDS,
  DEFAULT_CONTEXT_ROUNDS,
  MESSAGE_COLUMNS,
  normalizeContextRounds,
  recentHistoryCandidateLimit,
  loadVisibleHistoryCandidates,
  loadRecentVisibleHistory,
};
