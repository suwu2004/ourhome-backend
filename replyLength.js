const DEFAULT_CHAT_MIN_REPLY_CHARS = 80;
const DEFAULT_THEATER_MIN_REPLY_CHARS = 120;

function normalizeMinReplyChars(value, fallback = DEFAULT_CHAT_MIN_REPLY_CHARS, max = 1200) {
  const parsed = Number(value);
  const fallbackValue = Number.isFinite(Number(fallback)) ? Number(fallback) : DEFAULT_CHAT_MIN_REPLY_CHARS;
  if (!Number.isFinite(parsed)) return Math.round(Math.min(max, Math.max(0, fallbackValue)));
  return Math.round(Math.min(max, Math.max(0, parsed)));
}

function countReplyChars(value) {
  return Array.from(String(value || '').replace(/\s/g, '')).length;
}

function buildAdaptiveReplyInstruction(minChars, scene = 'chat') {
  const minimum = normalizeMinReplyChars(
    minChars,
    scene === 'theater' ? DEFAULT_THEATER_MIN_REPLY_CHARS : DEFAULT_CHAT_MIN_REPLY_CHARS,
  );
  const shared = [
    '根据这一轮的情绪、信息量和对话节奏自主决定篇幅，不使用固定长度或固定段落模板。',
    `完整回复至少 ${minimum} 字左右；这是下限，不是每次都要贴着下限写，也不是越长越好。`,
    '不要为了凑字数重复观点、复述对方的话、机械总结，或反复使用同一种句式。',
  ];
  if (scene === 'theater') {
    shared.push('如果核心接戏自然结束得较短，可以顺势补一小段世界内的环境余响、角色念头或生活细节；不要标成“题外话”，不要跳出小世界。');
    shared.push('不要复述或代替用户决定其角色已经写明之外的动作、感受和选择。');
  } else {
    shared.push('如果核心回答自然结束得较短，可以顺手带一两句松散的生活碎片、此刻的小念头或无须回答的题外话；不要标成“补充/题外话”，也不要生硬追问。');
    shared.push('除非对方明确要求接着描写，不要反复描述或改写对方的动作；少用“不是……而是……”式纠正句。');
  }
  return `\n\n【本轮回复篇幅】\n${shared.map(item => `- ${item}`).join('\n')}`;
}

function replyNeedsExtension(text, minChars) {
  return countReplyChars(text) < normalizeMinReplyChars(minChars);
}

function mergeReplySupplement(text, supplement) {
  const original = String(text || '').trim();
  const extra = String(supplement || '').trim();
  if (!extra) return original;
  if (!original) return extra;
  if (original.includes(extra)) return original;
  return `${original}\n\n${extra}`;
}

module.exports = {
  DEFAULT_CHAT_MIN_REPLY_CHARS,
  DEFAULT_THEATER_MIN_REPLY_CHARS,
  normalizeMinReplyChars,
  countReplyChars,
  buildAdaptiveReplyInstruction,
  replyNeedsExtension,
  mergeReplySupplement,
};
