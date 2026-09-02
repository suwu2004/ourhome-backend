'use strict';

const {
  estimateMessageTokens,
  selectRecentLifeHistory,
  selectRecentHistory,
} = require('./chatContextWindow');

const MAX_CONTEXT_ROUNDS = 500;
const DEFAULT_CONTEXT_ROUNDS = 48;
// Keep a wider cheap candidate window than the final prompt slice. A busy day can
// easily push yesterday's lunch/sleep/work fact beyond the previous 160-message
// boundary even though it is still inside the 72-hour life window.
const RECENT_LIFE_CANDIDATE_MESSAGES = 320;
const RECENT_LIFE_MAX_MESSAGES = 24;
const RECENT_LIFE_TOKEN_BUDGET = 1600;
const MESSAGE_COLUMNS = 'id, role, content, attachment_url, attachment_type, attachment_name, attachment_summary, reasoning_content, input_tokens, output_tokens, created_at';

function normalizeContextRounds(value, fallback = DEFAULT_CONTEXT_ROUNDS) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_CONTEXT_ROUNDS, parsed);
}

function recentHistoryCandidateLimit({ maxRounds, extraRows = 0 } = {}) {
  const rounds = normalizeContextRounds(maxRounds);
  const extra = Math.max(0, Math.min(8, Number.parseInt(extraRows, 10) || 0));
  return Math.max(rounds * 2 + extra, RECENT_LIFE_CANDIDATE_MESSAGES);
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

function mergeRecentLifeHistory(history, options = {}) {
  const normal = selectRecentHistory(history, {
    maxRounds: options.maxRounds,
    maxTokens: options.maxTokens ? Math.max(1, Number(options.maxTokens) - RECENT_LIFE_TOKEN_BUDGET) : options.maxTokens,
    minMessages: options.minMessages,
  });
  const life = selectRecentLifeHistory(history, {
    recentHours: 72,
    maxMessages: RECENT_LIFE_MAX_MESSAGES,
  });
  if (!life.length) return normal;

  const normalIds = new Set(normal.map(message => message?.id).filter(Boolean));
  const extras = life.filter(message => message?.id && !normalIds.has(message.id));
  if (!extras.length) return normal;

  const merged = [...normal, ...extras].sort((a, b) => {
    const at = new Date(a?.created_at || 0).getTime();
    const bt = new Date(b?.created_at || 0).getTime();
    if (at !== bt) return at - bt;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });

  const maxTokens = Number.parseInt(options.maxTokens, 10);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return merged;

  // 普通历史先占主要预算；最近生活事实最多占约1600 tokens，避免把上下文重新撑爆。
  let total = merged.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const extraIds = new Set(extras.map(message => message.id));
  for (let index = 0; index < merged.length && total > maxTokens; index += 1) {
    const message = merged[index];
    if (!extraIds.has(message?.id)) continue;
    total -= estimateMessageTokens(message);
    merged[index] = null;
  }
  return merged.filter(Boolean);
}

async function loadRecentVisibleHistory(supabase, sessionId, options = {}) {
  const candidates = await loadVisibleHistoryCandidates(supabase, sessionId, options);
  return mergeRecentLifeHistory(candidates, options);
}

module.exports = {
  MAX_CONTEXT_ROUNDS,
  DEFAULT_CONTEXT_ROUNDS,
  MESSAGE_COLUMNS,
  normalizeContextRounds,
  recentHistoryCandidateLimit,
  loadVisibleHistoryCandidates,
  loadRecentVisibleHistory,
  mergeRecentLifeHistory,
};
