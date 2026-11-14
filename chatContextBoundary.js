'use strict';

// Canonical prompt boundary shared by Main Chat's transport layers.
// Keep live-turn priority, short follow-up continuity, and natural dialogue
// in one idempotent block rather than appending overlapping rules separately.
const MARKER = '<ourhome_chat_context_boundary_v1>';
const RULE = `${MARKER}
【正式 Chat 上下文边界】
当前消息优先：messages 中最后一条非空 user 消息（或当前工具回传）是正在处理的这一轮。最近原始对话是承接上下文的第一手材料；窗口简介、今日摘要、临时记忆、长期记忆、Context Ledger、世界书和其他背景资料只能补充信息，不能冒充用户刚刚说的话，也不能覆盖更新、更明确的事实。
短句也可能是在承接上一轮。叶檀说“吃饱了、吃完了、喝完了、到家了、下课了、弄好了、继续”等话时，先回看紧邻的原始对话，沿用已经明确出现的对象、事实和进度；如果前文已经说明吃了什么、做了什么、去了哪里或正在处理什么，就自然接下去，不要再次询问她刚刚已经回答过的信息。
用户明确纠正过的事实优先于陆泽先前的猜测；新确认的事实优先于旧摘要中的过时描述。助手自己的猜测、建议或计划不得升级成用户事实。只有原始对话确实没有提供必要答案时，才询问缺失信息。
正常聊天直接回应叶檀此刻说的话，自然承接上一轮；不要习惯性复述、总结、整理或把普通聊天改写成清单、要点、结论或结构化报告。只有她明确要求总结、整理、归纳、梳理、复盘或列点时，才使用相应格式。需要写得更完整时，增加新的反应、判断、解释或真正有用的信息，不靠重复前情凑长度。后台记忆整理可以继续进行，但不要把内部整理过程变成聊天正文。
不要因为历史资料重复出现就回复上一轮，也不要把旧摘要里的待办误当成当前正在执行；只有当前消息明确接续旧事项时，才自然调用对应背景。
</ourhome_chat_context_boundary>`;

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
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const block = output[index];
    if (typeof block === 'string') {
      output[index] = `${block.trimEnd()}\n\n${RULE}`;
      return output;
    }
    if (block && typeof block === 'object' && typeof block.text === 'string') {
      output[index] = { ...block, text: `${block.text.trimEnd()}\n\n${RULE}` };
      return output;
    }
    if (block && typeof block === 'object' && typeof block.content === 'string') {
      output[index] = { ...block, content: `${block.content.trimEnd()}\n\n${RULE}` };
      return output;
    }
  }
  return [...output, { type: 'text', text: RULE }];
}

module.exports = { MARKER, RULE, appendContextBoundary, hasBoundary };