'use strict';

const DEFAULT_MAX_CHARS = 18000;

function compactTheaterHistory(entries = [], formatEntry, maxChars = DEFAULT_MAX_CHARS) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return '';
  const limit = Math.max(1000, Number(maxChars) || DEFAULT_MAX_CHARS);
  const formatter = typeof formatEntry === 'function'
    ? formatEntry
    : item => String(item?.content || '');

  const rendered = list.map(item => String(formatter(item) || '').trim()).filter(Boolean);
  if (!rendered.length) return '';

  const kept = [];
  let chars = 0;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const piece = rendered[index];
    const separator = kept.length ? 2 : 0;
    if (chars + separator + piece.length <= limit) {
      kept.unshift(piece);
      chars += separator + piece.length;
      continue;
    }

    // If the newest single turn is itself oversized, keep its tail rather than
    // silently dropping the live scene altogether.
    if (!kept.length) {
      const tailBudget = Math.max(240, limit);
      kept.unshift(piece.slice(-tailBudget));
    }
    break;
  }
  return kept.join('\n\n');
}

module.exports = { DEFAULT_MAX_CHARS, compactTheaterHistory };
