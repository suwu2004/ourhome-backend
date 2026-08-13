'use strict';

function compactText(value, max = 260) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function fallbackDiarySummary(title, content, max = 260) {
  const cleanTitle = compactText(title, 48);
  const cleanContent = compactText(content, Math.max(max * 2, 520));
  if (!cleanContent) return cleanTitle;

  const sentences = cleanContent
    .split(/(?<=[。！？!?])/u)
    .map(part => part.trim())
    .filter(Boolean);
  const picked = [];
  for (const sentence of sentences) {
    const candidate = compactText([...picked, sentence].join(''), max);
    if (!candidate) continue;
    picked.push(sentence);
    if (candidate.length >= Math.min(120, max) || picked.length >= 2) break;
  }
  const body = compactText(picked.join('') || cleanContent, max);
  return compactText(cleanTitle && !body.includes(cleanTitle) ? `${cleanTitle}：${body}` : body, max);
}

function parseScheduledDiaryResponse(replyText) {
  const text = String(replyText || '').replace(/\r/g, '').trim();
  const titleMatch = text.match(/^标题[：:]\s*(.+)$/m);
  const summaryMatch = text.match(/^摘要[：:]\s*(.+)$/m);
  const bodyMatch = text.match(/^正文[：:]\s*([\s\S]+)$/m);
  const title = compactText(titleMatch?.[1] || '今天的小幸福', 12);

  let content = bodyMatch?.[1]?.trim() || text;
  if (!bodyMatch) {
    if (titleMatch) content = content.replace(titleMatch[0], '');
    if (summaryMatch) content = content.replace(summaryMatch[0], '');
    content = content.replace(/^正文[：:]?\s*/m, '').trim();
  }

  return {
    title,
    content,
    summary: compactText(summaryMatch?.[1], 260) || fallbackDiarySummary(title, content),
  };
}

module.exports = {
  compactText,
  fallbackDiarySummary,
  parseScheduledDiaryResponse,
};
