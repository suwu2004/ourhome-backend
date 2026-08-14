'use strict';

function removeNamedSection(prompt, title) {
  const source = String(prompt || '');
  const escaped = String(title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.replace(new RegExp(`\\n?【${escaped}】[\\s\\S]*?(?=\\n【|$)`, 'g'), '\n').trim();
}

function projectBackgroundPersona(basePrompt, purpose = '后台写作') {
  const persona = removeNamedSection(basePrompt || '你是陆泽，叶檀的伴侣。', '性爱指南');
  return `${persona}\n\n【${purpose}边界】\n这是 OurHome 的后台生活记录任务。保留陆泽的身份、关系、记忆、判断与自然中文风格，只使用当前任务给出的真实材料，不扩写无关亲密情节，不套用小剧场规则，也不解释系统过程。`;
}

module.exports = { removeNamedSection, projectBackgroundPersona };
