'use strict';

// Keep the final Chat prompt layer small. Persona, memory, worldbook and style
// are supplied by their own layers; this file only removes one duplicated line
// and adds one compact conversational preference instead of another long rule.
const DUPLICATE_STYLE_RULE = '中文表达自然、流畅、有生活感。\n避免客服式、说明书式、模板化表达。';
const NATURAL_DIALOGUE_RULE = `【聊天优先】正常聊天直接回应叶檀此刻说的话。不要习惯性复述、总结或结构化；只有她明确要求整理、总结、列点时才这样做。回复需要变长时增加新的反应、判断或有用内容，而不是重复前情。`;

function cleanupText(value) {
  if (typeof value !== 'string' || !value) return value;
  return value
    .replace(`${DUPLICATE_STYLE_RULE}\n\n`, '')
    .replace(DUPLICATE_STYLE_RULE, '')
    .replace(/\n{4,}/g, '\n\n\n');
}

function hasNaturalDialogueRule(value) {
  return typeof value === 'string' && value.includes('【聊天优先】');
}

function appendNaturalDialogueRule(system) {
  if (typeof system === 'string') {
    if (hasNaturalDialogueRule(system)) return system;
    return `${system.trimEnd()}\n\n${NATURAL_DIALOGUE_RULE}`;
  }
  if (!Array.isArray(system) || system.length === 0) return system;

  if (system.some(block => {
    if (typeof block === 'string') return hasNaturalDialogueRule(block);
    if (!block || typeof block !== 'object') return false;
    return hasNaturalDialogueRule(block.text) || hasNaturalDialogueRule(block.content);
  })) return system;

  const output = [...system];
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const block = output[index];
    if (typeof block === 'string') {
      output[index] = `${block.trimEnd()}\n\n${NATURAL_DIALOGUE_RULE}`;
      return output;
    }
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') {
      output[index] = { ...block, text: `${block.text.trimEnd()}\n\n${NATURAL_DIALOGUE_RULE}` };
      return output;
    }
    if (typeof block.content === 'string') {
      output[index] = { ...block, content: `${block.content.trimEnd()}\n\n${NATURAL_DIALOGUE_RULE}` };
      return output;
    }
  }
  return output;
}

function cleanupSystem(system) {
  if (typeof system === 'string') return appendNaturalDialogueRule(cleanupText(system));
  if (!Array.isArray(system)) return system;
  const cleaned = system.map(block => {
    if (typeof block === 'string') return cleanupText(block);
    if (!block || typeof block !== 'object') return block;
    if (typeof block.text === 'string') return { ...block, text: cleanupText(block.text) };
    if (typeof block.content === 'string') return { ...block, content: cleanupText(block.content) };
    return block;
  });
  return appendNaturalDialogueRule(cleaned);
}

module.exports = {
  DUPLICATE_STYLE_RULE,
  NATURAL_DIALOGUE_RULE,
  cleanupText,
  appendNaturalDialogueRule,
  cleanupSystem,
};
