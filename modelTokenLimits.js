const STANDARD_OUTPUT_TOKEN_CAP = 32_000;
const EXTENDED_OUTPUT_TOKEN_CAP = 64_000;

function normalizeModelName(model) {
  return String(model || '').trim();
}

function outputTokenCapForModel(model) {
  const name = normalizeModelName(model);
  if (/^\[(?:PX|CX)\]/i.test(name) || /(?:^|[-_\s])64k(?:$|[-_\s])/i.test(name)) {
    return EXTENDED_OUTPUT_TOKEN_CAP;
  }
  return STANDARD_OUTPUT_TOKEN_CAP;
}

function clampRequestedOutputTokens(model, requestedTokens) {
  const cap = outputTokenCapForModel(model);
  const parsed = Number(requestedTokens);
  if (!Number.isFinite(parsed) || parsed <= 0) return cap;
  return Math.max(1, Math.min(Math.round(parsed), cap));
}

module.exports = {
  STANDARD_OUTPUT_TOKEN_CAP,
  EXTENDED_OUTPUT_TOKEN_CAP,
  outputTokenCapForModel,
  clampRequestedOutputTokens,
};
