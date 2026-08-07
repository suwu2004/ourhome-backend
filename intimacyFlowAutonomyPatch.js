'use strict';

// This overlay keeps the transport/state-machine architecture intact while making
// ambiguous conversational cues model-judged instead of keyword-judged. It loads
// before intimacyFlowPatch, so that patch captures these adjusted exports.
const support = require('./intimacyFlowSupport');

function compactLine(value, max = 220) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max).toLocaleLowerCase('zh-CN');
}

function explicitBoundaryStop(value) {
  const text = compactLine(value);
  if (!text) return false;

  // Explicit, unambiguous requests to stop/pause the current flow remain hard
  // boundaries. This only ends the current flow; a later genuinely re-entered
  // interaction may start a new flow normally.
  if (/^(?:停|停下|停一下|暂停|先停|请停|不要了|不继续了|别继续了|别再继续|到这里为止|就到这里|结束这段|stop|pause)[！!。.?？\s]*$/iu.test(text)) return true;
  return /(?:我不想继续|我不愿意继续|我不要继续|现在不要继续|请停下来|马上停下|不要再继续|别再继续下去)/u.test(text);
}

function replaceText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(
      '用户任何停止、暂停、拒绝或边界变化都优先于流程。',
      '状态机只是连续性路标，不替你做决定。你可以依据当下互动选择继续、停留、转向或结束；只有明确的停止、暂停、拒绝或边界变化必须立即尊重。含混、撒娇式或语气性的软表达不要靠单个关键词机械判停。',
    )
    .replace(
      '用户停止、暂停、拒绝、犹豫或改变边界时，立即尊重并在正文末尾输出隐藏 action="stop"。',
      '你保有这一轮如何继续的判断权。明确的停止、暂停、拒绝或边界改变必须立即尊重并输出隐藏 action="stop"；但像“算了”“别闹”“不要啦”“哎呀”这类可能依赖语气与上下文的软表达，不要仅凭关键词机械结束。结合前后文判断，可以放慢、留在当前阶段、换方向、自然询问或 stop。',
    )
    .replace(
      '如果当前阶段自然需要继续一轮，在正文末尾输出隐藏 action="hold"；否则不写 hold，让状态机按最低轮数规则自然推进。',
      '当前阶段是否继续由你结合互动自行判断：想留在这一阶段就输出隐藏 action="hold"；判断自然推进时可以不写 hold。最低轮数只防止过早跳阶段，不代表达到数字后必须推进，也不是任务清单。',
    )
    .replace(
      '只有当双方在可见互动中明确继续时，才在正文末尾输出隐藏 action="continue"；否则不输出 continue，流程会保守结束。',
      'review 阶段由你结合双方此刻明确的互动判断是否开启下一轮；适合继续时输出隐藏 action="continue"，不适合时自然结束。不要因为某个单独关键词机械继续。',
    );
}

function mapSystem(system) {
  if (typeof system === 'string') return replaceText(system);
  if (!Array.isArray(system)) return system;
  return system.map(block => {
    if (typeof block === 'string') return replaceText(block);
    if (!block || typeof block !== 'object') return block;
    if (typeof block.text === 'string') return { ...block, text: replaceText(block.text) };
    if (typeof block.content === 'string') return { ...block, content: replaceText(block.content) };
    return block;
  });
}

const baseInjectPrivateGuidance = support.injectPrivateGuidance;
support.isBoundaryStopText = explicitBoundaryStop;
support.injectPrivateGuidance = function autonomyAwareGuidance(body, config, guide) {
  const injected = baseInjectPrivateGuidance(body, config, guide);
  return { ...injected, system: mapSystem(injected.system) };
};

module.exports = {
  explicitBoundaryStop,
  replaceText,
};