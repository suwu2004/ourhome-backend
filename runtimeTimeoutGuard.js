'use strict';

// Small helper calls should never hold a room hostage when the relay is unhealthy.
// These are single-call ceilings only: this module never retries a paid request.
const LEARNING_PLAN_TIMEOUT_MS = 60_000;
const VISION_READER_TIMEOUT_MS = 150_000;
const DAILY_WRITING_TIMEOUT_MS = 120_000;
const TOYBOX_TIMEOUT_MS = 75_000;
const HEARTBEAT_TIMEOUT_MS = 75_000;

function safeJsonBody(init = {}) {
  if (typeof init?.body !== 'string') return null;
  try { return JSON.parse(init.body); } catch { return null; }
}

function headerPurpose(headers) {
  try {
    return String(new Headers(headers || undefined).get('X-OurHome-Call-Purpose') || '').trim();
  } catch {
    return '';
  }
}

function systemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map(block => typeof block === 'string' ? block : block?.text || block?.content || '')
    .filter(Boolean)
    .join('\n');
}

function messageText(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map(message => {
      if (typeof message?.content === 'string') return message.content;
      if (!Array.isArray(message?.content)) return '';
      return message.content
        .map(block => typeof block === 'string' ? block : block?.text || block?.content || '')
        .filter(Boolean)
        .join('\n');
    })
    .filter(Boolean)
    .join('\n');
}

function isVisionReaderText(system, text) {
  return system.includes('OurHome 的图片代读器') || text.includes('OurHome 的图片代读器');
}

function isDailyWritingText(text) {
  return text.includes('现在已经到了每天收好这一天的时间')
    || text.includes('心情日历里已经写下的内容')
    || text.includes('给今天留一个心情表情和一小段真诚自然的话')
    || (text.includes('属于"幸福日记"的日记') && text.includes('严格按照这个格式输出'));
}

function timeoutForRequest(init = {}) {
  const purpose = headerPurpose(init.headers);
  if (purpose === 'luze-learning-plan') return LEARNING_PLAN_TIMEOUT_MS;
  if (purpose === 'vision-reader') return VISION_READER_TIMEOUT_MS;
  if (purpose === 'daily-writing' || purpose === 'happiness-diary' || purpose === 'daily-mood') {
    return DAILY_WRITING_TIMEOUT_MS;
  }

  const body = safeJsonBody(init);
  if (!body || typeof body !== 'object' || !body.model) return 0;
  const system = systemText(body.system);
  const text = `${system}\n${messageText(body.messages)}`;

  if (isVisionReaderText(system, text)) return VISION_READER_TIMEOUT_MS;
  if (isDailyWritingText(text)) return DAILY_WRITING_TIMEOUT_MS;
  if (text.includes('【玩具箱】') || text.includes('【玩具熊】')) return TOYBOX_TIMEOUT_MS;
  if (text.includes('自动心跳提醒你')) return HEARTBEAT_TIMEOUT_MS;
  return 0;
}

module.exports = {
  LEARNING_PLAN_TIMEOUT_MS,
  VISION_READER_TIMEOUT_MS,
  DAILY_WRITING_TIMEOUT_MS,
  TOYBOX_TIMEOUT_MS,
  HEARTBEAT_TIMEOUT_MS,
  safeJsonBody,
  headerPurpose,
  systemText,
  messageText,
  isVisionReaderText,
  isDailyWritingText,
  timeoutForRequest,
};
