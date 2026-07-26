'use strict';

const { redactHardPrivacyValues } = require('./emailPrivacy');

function compact(value, max) {
  return redactHardPrivacyValues(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, max);
}

function shortDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function buildAgentMailReference({ messages = [], memories = [], letters = [] } = {}) {
  const sections = [];
  const chat = [...messages].reverse()
    .map(item => {
      const content = compact(item?.content, 420);
      if (!content) return '';
      const author = item?.role === 'user' ? '叶檀' : '陆泽';
      const date = shortDate(item?.created_at);
      return `- ${date ? `${date} ` : ''}${author}：${content}`;
    })
    .filter(Boolean)
    .join('\n');
  if (chat) sections.push(`【最近聊天】\n${chat}`);

  const memoryText = memories
    .map(item => {
      const summary = compact(item?.summary, 380);
      if (!summary) return '';
      const kind = item?.is_protected ? '核心记忆' : '记忆';
      const date = shortDate(item?.timestamp);
      return `- [${kind}${date ? ` · ${date}` : ''}] ${summary}`;
    })
    .filter(Boolean)
    .join('\n');
  if (memoryText) sections.push(`【最近记忆】\n${memoryText}`);

  const letterText = letters
    .map(item => {
      const content = compact(item?.content, 480);
      if (!content) return '';
      const category = compact(item?.category, 40) || '信件';
      const author = compact(item?.author, 30) || '未署名';
      const title = compact(item?.title, 100);
      const date = shortDate(item?.created_at);
      return `- [${category}${date ? ` · ${date}` : ''}] ${author}${title ? `《${title}》` : ''}：${content}`;
    })
    .filter(Boolean)
    .join('\n');
  if (letterText) sections.push(`【最近信件与日记】\n${letterText}`);

  return sections.join('\n\n').slice(0, 18_000);
}

module.exports = {
  buildAgentMailReference,
};
