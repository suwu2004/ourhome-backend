'use strict';

// Single prompt-boundary layer for Main Chat.
// Keep current-turn priority and natural-dialogue behavior together so multiple
// fetch patches do not independently append overlapping instructions.
const MARKER = '<ourhome_chat_context_boundary_v1>';
const RULE = `${MARKER}\n【正式 Chat 上下文边界】\n当前消息优先：messages 数组中最后一条非空 user 消息（或当前工具回传）是正在处理的这一轮。最近对话负责承接上下文；今日摘要、长期记忆、Context Ledger、世界书及其他背景材料只能作为参考，不能冒充当前用户刚刚说的话。\n正常聊天时直接回应当前这一刻并自然承接上一轮，不要机械复述、总结、整理或把普通聊天改写成清单；只有用户明确要求总结、整理、归纳、梳理、复盘或列清单时才这样做。若背景与当前消息在话题或时序上冲突，以当前消息和最近真实对话为准。\n</ourhome_chat_context_boundary_v1>`;

function contentOf(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  return String(block.text ?? block.content ?? '');
}

function hasBoundary(system) {
  if (typeof system === 'string') return system.includes(MARKER);
  if (Array.isArray(system)) return system.some(block => contentOf(block).includes(MARKER));
  return false;
}

function appendContextBoundary(system) {
  if (hasBoundary(system)) return system;
  if (typeof system === 'string') return `${system.trimEnd()}\n\n${RULE}`;
  if (!Array.isArray(system)) return RULE;
  const output = [...system];
  for (let i = output.length - 1; i >= 0; i -= 1) {
    const block = output[i];
    if (typeof block === 'string') {
      output[i] = `${block.trimEnd()}\n\n${RULE}`;
      return output;
    }
    if (block && typeof block === 'object' && typeof block.text === 'string') {
      output[i] = { ...block, text: `${block.text.trimEnd()}\n\n${RULE}` };
      return output;
    }
    if (block && typeof block === 'object' && typeof block.content === 'string') {
      output[i] = { ...block, content: `${block.content.trimEnd()}\n\n${RULE}` };
      return output;
    }
  }
  return [...output, { type: 'text', text: RULE }];
}

module.exports = { MARKER, RULE, appendContextBoundary, hasBoundary };
