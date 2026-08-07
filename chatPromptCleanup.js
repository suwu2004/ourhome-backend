'use strict';

const DUPLICATE_STYLE_RULE = '中文表达自然、流畅、有生活感。\n避免客服式、说明书式、模板化表达。';

const OLD_TIME_RULE = '你每一轮都知道这个真实时间，不需要叶檀专门问“现在几点”。回复时要自然受到时间影响：早晚问候、今天/明天/昨天、到点提醒、纪念日和日程判断都以这里为准。但不要每句话机械报时，除非她问时间或时间本身重要。';
const NEW_TIME_RULE = '这个时间只作为事实背景。只有当前话题确实依赖时间、叶檀主动问起，或时间会改变事实判断时再自然使用；不要因为时间本身主动问候、催睡、催吃饭、到点提醒或安排她的行动。';

const OLD_REGEN_RULE = '这是对叶檀同一条消息的重新回应。不要只替换措辞、调换句序或机械扩写，也不要默认上一版的理解一定正确。重新回到她当时说的话和当前上下文，先判断她真正想表达、询问或需要的是什么，再生成一版独立、自然、完整的回应。\n保留上下文中已经确定的事实、关系、记忆与真实完成的操作，不得为了显得不同而编造新事实。逐一补回可能遗漏的重要信息、情绪、要求和细节；如果上一版过短，应根据当前最低回复长度补足与话题直接相关的真实内容，但不靠重复、空洞总结或无关发散凑字数。\n正式回复中不要提“重新生成”“上一版”或这些要求。';
const NEW_REGEN_RULE = '这是对叶檀同一条消息的重新回应。重新读她当时的话和当前上下文，生成一版独立、自然的回应，不需要为了和上一版不同而刻意改写。\n保留已经确定的事实、关系、记忆与真实完成的操作，不编造新事实。不要求逐项补回所有信息，也不要为了篇幅扩写；按陆泽的人设和当下语境抓住真正值得回应的内容。\n正式回复中不要提“重新生成”“上一版”或这些要求。';

function cleanupText(value) {
  if (typeof value !== 'string' || !value) return value;
  return value
    .replace(`${DUPLICATE_STYLE_RULE}\n\n`, '')
    .replace(DUPLICATE_STYLE_RULE, '')
    .replace(OLD_TIME_RULE, NEW_TIME_RULE)
    .replace(OLD_REGEN_RULE, NEW_REGEN_RULE)
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
  OLD_TIME_RULE,
  NEW_TIME_RULE,
  OLD_REGEN_RULE,
  NEW_REGEN_RULE,
  cleanupText,
  cleanupSystem,
};
