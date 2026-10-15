const {
  buildAdaptiveReplyInstruction,
} = require('./promptRules');

// Formal Chat should not default to a one- or two-sentence answer. This is a
// soft minimum used to guide the model, not a hard truncation requirement.
const DEFAULT_CHAT_MIN_REPLY_CHARS = 140;
const DEFAULT_THEATER_MIN_REPLY_CHARS = 120;
const MAX_CHAT_MIN_REPLY_CHARS = 1200;
const MAX_THEATER_MIN_REPLY_CHARS = 4000;

function normalizeMinReplyChars(value, fallback = DEFAULT_CHAT_MIN_REPLY_CHARS, max = null) {
  const parsed = Number(value);
  const fallbackValue = Number.isFinite(Number(fallback)) ? Number(fallback) : DEFAULT_CHAT_MIN_REPLY_CHARS;
  const inferredMax = fallbackValue === DEFAULT_THEATER_MIN_REPLY_CHARS
    ? MAX_THEATER_MIN_REPLY_CHARS
    : MAX_CHAT_MIN_REPLY_CHARS;
  const explicitMax = max === null || max === undefined || max === '' ? Number.NaN : Number(max);
  const safeMax = Number.isFinite(explicitMax) ? Math.max(0, explicitMax) : inferredMax;
  if (!Number.isFinite(parsed)) return Math.round(Math.min(safeMax, Math.max(0, fallbackValue)));
  return Math.round(Math.min(safeMax, Math.max(0, parsed)));
}

/**
 * Convert the configured Chinese-character target into enough output tokens.
 * Providers tokenize Chinese differently, so reserve a conservative margin.
 * The saved max_reply_tokens remains the baseline, while the character target
 * can raise it when the two settings would otherwise conflict.
 */
function calculateChatReplyTokenBudget(minReplyChars, configuredTokens) {
  const parsedTokens = Number(configuredTokens);
  const configured = Number.isFinite(parsedTokens) && parsedTokens > 0
    ? Math.round(parsedTokens)
    : 1000;
  const minimum = normalizeMinReplyChars(
    minReplyChars,
    DEFAULT_CHAT_MIN_REPLY_CHARS,
    MAX_CHAT_MIN_REPLY_CHARS,
  );
  const targetBudget = minimum > 0 ? Math.ceil(minimum * 1.8) : 0;
  return Math.max(500, configured, targetBudget);
}

module.exports = {
  DEFAULT_CHAT_MIN_REPLY_CHARS,
  DEFAULT_THEATER_MIN_REPLY_CHARS,
  MAX_CHAT_MIN_REPLY_CHARS,
  MAX_THEATER_MIN_REPLY_CHARS,
  normalizeMinReplyChars,
  calculateChatReplyTokenBudget,
  buildAdaptiveReplyInstruction,
};
