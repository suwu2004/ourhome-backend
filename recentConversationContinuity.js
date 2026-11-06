'use strict';

const DEFAULT_OPTIONS = Object.freeze({
  maxMessages: 10,
  maxMessageChars: 340,
  maxTotalChars: 3_800,
});

function compact(value) {
  return String(value ?? '')
    .replace(/<intimacy_control\\b[^<>]*\\/?>/gi, '')
    .replace(/<scheduler_control\\b[^<>]*\\/?>/gi, '')
    .replace(/<external_flow_control\\b[^<>]*\\/?>/gi, '')
    .replace(/^\\[历史时间[：:]\\s*[^\\]]+\\]\\s*/u, '')
    .replace(/\\s+/g, ' ')
    .trim();
}

function clipText(value, maxChars) {
  const text = compact(value);
  if (text.length <= maxChars) return text;
  const head = Math.max(1, Math.floor(maxChars * 0.78));
  const tail = Math.max(0, maxChars - head - 8);
  return text.slice(0, head) + '……[略]……' + (tail ? text.slice(-tail) : '');
}

function timeLabel(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date).replace(/\\//g, '-');
}

function buildRecentConversationContinuityBlock(history = [], options = {}) {
  const maxMessages = Math.max(2, Math.min(20, Number(options.maxMessages) || DEFAULT_OPTIONS.maxMessages));
  const maxMessageChars = Math.max(120, Math.min(800, Number(options.maxMessageChars) || DEFAULT_OPTIONS.maxMessageChars));
  const maxTotalChars = Math.max(800, Math.min(6_000, Number(options.maxTotalChars) || DEFAULT_OPTIONS.maxTotalChars));
  const source = (Array.isArray(history) ? history : [])
    .filter(row => row && (row.role === 'user' || row.role === 'assistant'))
    .filter(row => compact(row.content) || compact(row.attachment_summary) || compact(row.attachment_name))
    .slice(-maxMessages);

  if (!source.length) return '';

  const rendered = [];
  let used = 0;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const row = source[index];
    const role = row.role === 'user' ? '叶檀' : '陆泽';
    const time = timeLabel(row.created_at);
    const content = clipText(row.content, maxMessageChars);
    const attachment = compact(row.attachment_summary || row.attachment_name);
    const detail = [content, attachment ? '【附件信息】' + clipText(attachment, 180) : ''].filter(Boolean).join(' ');
    const line = '- ' + (time ? '[' + time + '] ' : '') + role + '：' + detail;
    if (used + line.length + 1 > maxTotalChars) continue;
    rendered.push(line);
    used += line.length + 1;
  }

  if (!rendered.length) return '';
  rendered.reverse();
  return [
    '【最近对话连续性摘录｜接话前必须核对】',
    '以下是当前窗口最近的原始消息，按时间正序排列。它们是近程事实依据，不是旧摘要或推测。',
    '1. 先核对最近几轮已经明确出现的事实；用户已经回答过的信息，不要换个说法再问一次。',
    '2. 用户说“吃饱了、喝完了、到家了、弄好了、继续”等承接句时，先回看摘录中最近一次相关细节，再自然接话。',
    '3. 区分用户明确说过的事实与陆泽自己的猜测；用户后续澄清优先于陆泽先前的推测。',
    '4. 只有摘录确实没有答案时，才询问缺失的信息；不要用宽泛问题让用户重复刚讲过的内容。',
    ...rendered,
  ].join('\\n');
}

module.exports = { buildRecentConversationContinuityBlock, clipText };
