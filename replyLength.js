const {
  buildAdaptiveReplyInstruction,
} = require('./promptRules');

const DEFAULT_CHAT_MIN_REPLY_CHARS = 80;
const DEFAULT_THEATER_MIN_REPLY_CHARS = 120;

function normalizeMinReplyChars(value, fallback = DEFAULT_CHAT_MIN_REPLY_CHARS, max = 1200) {
  const parsed = Number(value);
  const fallbackValue = Number.isFinite(Number(fallback)) ? Number(fallback) : DEFAULT_CHAT_MIN_REPLY_CHARS;
  if (!Number.isFinite(parsed)) return Math.round(Math.min(max, Math.max(0, fallbackValue)));
  return Math.round(Math.min(max, Math.max(0, parsed)));
}

module.exports = {
  DEFAULT_CHAT_MIN_REPLY_CHARS,
  DEFAULT_THEATER_MIN_REPLY_CHARS,
  normalizeMinReplyChars,
  buildAdaptiveReplyInstruction,
};
