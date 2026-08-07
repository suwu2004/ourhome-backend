'use strict';

// Keep the transport cleanup deliberately narrow. The database persona, memory,
// current context, time awareness and regenerate-value rules are all intentional
// parts of Chat behavior; this layer only removes a duplicated style sentence that
// would otherwise repeat the database's compact communication principles.
const DUPLICATE_STYLE_RULE = '中文表达自然、流畅、有生活感。\n避免客服式、说明书式、模板化表达。';

function cleanupText(value) {
  if (typeof value !== 'string' || !value) return value;
  return value
    .replace(`${DUPLICATE_STYLE_RULE}\n\n`, '')
    .replace(DUPLICATE_STYLE_RULE, '')
    .replace(/\n{4,}/g, '\n\n\n');
}

function cleanupSystem(system) {
  if (typeof system === 'string') return cleanupText(system);
  if (!Array.isArray(system)) return system;
  return system.map(block => {
    if (typeof block === 'string') return cleanupText(block);
    if (!block || typeof block !== 'object') return block;
    if (typeof block.text === 'string') return { ...block, text: cleanupText(block.text) };
    if (typeof block.content === 'string') return { ...block, content: cleanupText(block.content) };
    return block;
  });
}

module.exports = {
  DUPLICATE_STYLE_RULE,
  cleanupText,
  cleanupSystem,
};
