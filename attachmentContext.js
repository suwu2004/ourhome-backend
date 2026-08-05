const MAX_ATTACHMENT_SUMMARY_CHARS = 3200;

function normalizeAttachmentSummary(value, max = MAX_ATTACHMENT_SUMMARY_CHARS) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, max);
}

function previousAttachmentLabel(message = {}) {
  if (String(message.attachment_type || '').startsWith('image/')) {
    const summary = normalizeAttachmentSummary(message.attachment_summary);
    return summary
      ? `[之前发过一张图片；当时已经确认看到的内容：${summary}]`
      : '[之前发过一张图片，但当时没有保存可复用的识图描述]';
  }
  return `[之前发过一个文件：${message.attachment_name || '文件'}]`;
}

function latestImageMessageId(history = []) {
  const row = [...(history || [])]
    .reverse()
    .find(item => item?.id && item?.attachment_url && String(item.attachment_type || '').startsWith('image/'));
  return row?.id || null;
}

module.exports = {
  MAX_ATTACHMENT_SUMMARY_CHARS,
  normalizeAttachmentSummary,
  previousAttachmentLabel,
  latestImageMessageId,
};
