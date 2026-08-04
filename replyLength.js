const DEFAULT_CHAT_MIN_REPLY_CHARS = 80;
const DEFAULT_THEATER_MIN_REPLY_CHARS = 120;

function normalizeMinReplyChars(value, fallback = DEFAULT_CHAT_MIN_REPLY_CHARS, max = 1200) {
  const parsed = Number(value);
  const fallbackValue = Number.isFinite(Number(fallback)) ? Number(fallback) : DEFAULT_CHAT_MIN_REPLY_CHARS;
  if (!Number.isFinite(parsed)) return Math.round(Math.min(max, Math.max(0, fallbackValue)));
  return Math.round(Math.min(max, Math.max(0, parsed)));
}

function buildAdaptiveReplyInstruction(minChars, scene = 'chat') {
  const minimum = normalizeMinReplyChars(
    minChars,
    scene === 'theater' ? DEFAULT_THEATER_MIN_REPLY_CHARS : DEFAULT_CHAT_MIN_REPLY_CHARS,
  );
  const shared = [
    '根据这一轮的情绪、信息量和对话节奏自主决定篇幅，不使用固定长度或固定段落模板。',
    `正常情况下把 ${minimum} 字左右作为最低篇幅目标；如果当前内容已经自然结束，可以短一些，不必硬凑。`,
    '回复一次说完。不要为了凑字数重复观点、复述对方的话、机械总结，也不要在已经收束后用“其实”“另外”“顺便”另起一段。',
  ];
  if (scene === 'theater') {
    shared.push('只围绕当前正在发生的动作、对话或情绪推进；不要为了篇幅添加新的背景轶事、回忆或无关细节。');
    shared.push('不要复述或代替用户决定其角色已经写明之外的动作、感受和选择。');
  } else {
    shared.push('只围绕对方这一轮正在谈的事情、问题或情绪回应；不偏离当前话题，不引入这一轮未提及的新内容。');
    shared.push('除非对方明确要求接着描写，不要反复描述或改写对方的动作；少用“不是……而是……”式纠正句。');
  }
  return `\n\n【本轮回复篇幅】\n${shared.map(item => `- ${item}`).join('\n')}`;
}

module.exports = {
  DEFAULT_CHAT_MIN_REPLY_CHARS,
  DEFAULT_THEATER_MIN_REPLY_CHARS,
  normalizeMinReplyChars,
  buildAdaptiveReplyInstruction,
};
