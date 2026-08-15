const {
  buildAdaptiveReplyInstruction,
} = require('./promptRules');

const DEFAULT_CHAT_MIN_REPLY_CHARS = 80;
const DEFAULT_THEATER_MIN_REPLY_CHARS = 120;
const MAX_CHAT_MIN_REPLY_CHARS = 1200;
const MAX_THEATER_MIN_REPLY_CHARS = 4000;

function normalizeMinReplyChars(value, fallback = DEFAULT_CHAT_MIN_REPLY_CHARS, max = null) {
  const parsed = Number(value);
  const fallbackValue = Number.isFinite(Number(fallback)) ? Number(fallback) : DEFAULT_CHAT_MIN_REPLY_CHARS;
  const inferredMax = fallbackValue === DEFAULT_THEATER_MIN_REPLY_CHARS
    ? MAX_THEATER_MIN_REPLY_CHARS
    : MAX_CHAT_MIN_REPLY_CHARS;
  const safeMax = Number.isFinite(Number(max)) ? Math.max(0, Number(max)) : inferredMax;
  if (!Number.isFinite(parsed)) return Math.round(Math.min(safeMax, Math.max(0, fallbackValue)));
  return Math.round(Math.min(safeMax, Math.max(0, parsed)));
}

module.exports = {
  DEFAULT_CHAT_MIN_REPLY_CHARS,
  DEFAULT_THEATER_MIN_REPLY_CHARS,
  MAX_CHAT_MIN_REPLY_CHARS,
  MAX_THEATER_MIN_REPLY_CHARS,
  normalizeMinReplyChars,
  buildAdaptiveReplyInstruction,
};
