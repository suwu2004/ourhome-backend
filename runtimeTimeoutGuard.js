'use strict';

const LEARNING_PLAN_TIMEOUT_MS = 90_000;
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

function timeoutForRequest(init = {}) {
  const purpose = headerPurpose(init.headers);
  if (purpose === 'luze-learning-plan') return LEARNING_PLAN_TIMEOUT_MS;

  const body = safeJsonBody(init);
  if (!body || typeof body !== 'object' || !body.model) return 0;
  const text = `${systemText(body.system)}\n${messageText(body.messages)}`;

  if (text.includes('【玩具箱】') || text.includes('【玩具熊】')) return TOYBOX_TIMEOUT_MS;
  if (text.includes('自动心跳提醒你')) return HEARTBEAT_TIMEOUT_MS;
  return 0;
}

module.exports = {
  LEARNING_PLAN_TIMEOUT_MS,
  TOYBOX_TIMEOUT_MS,
  HEARTBEAT_TIMEOUT_MS,
  safeJsonBody,
  headerPurpose,
  systemText,
  messageText,
  timeoutForRequest,
};
