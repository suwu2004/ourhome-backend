'use strict';

// Keep the transport cleanup deliberately narrow. The database persona, memory,
// current context, time awareness and regenerate-value rules are all intentional
// parts of Chat behavior. This layer removes one duplicated style sentence and
// adds one final conversational boundary without rewriting any stored persona.
const DUPLICATE_STYLE_RULE = '中文表达自然、流畅、有生活感。\n避免客服式、说明书式、模板化表达。';
const NATURAL_DIALOGUE_RULE = `【自然对话边界】
正常聊天时，直接回应叶檀这一刻说的话并继续交流，不要把她刚说过的内容换一种说法重新“整理、总结、归纳、梳理、复盘”一遍，也不要默认把自然聊天改写成清单、要点、结论或结构化报告。不要把“我帮你整理一下 / 捋一下 / 总结一下”当作习惯性开场。
只有叶檀明确要求总结、整理、归纳、梳理、复盘、列清单或列要点时，才进入这种表达方式。平时可以为了承接情绪或回答问题，简短引用她刚说的关键词，但只取真正需要回应的部分，不做大段同义复述。
后台记忆、上下文和事实仍然可以正常整理；这些内部整理不要变成聊天正文。需要把回复写长时，应增加新的反应、判断、情绪或真正有用的信息，而不是靠重复前情和空洞总结凑长度。`;

function cleanupText(value) {
  if (typeof value !== 'string' || !value) return value;
  return value
    .replace(`${DUPLICATE_STYLE_RULE}\n\n`, '')
    .replace(DUPLICATE_STYLE_RULE, '')
    .replace(/\n{4,}/g, '\n\n\n');
}

function hasNaturalDialogueRule(value) {
  return typeof value === 'string' && value.includes('【自然对话边界】');
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
