'use strict';

function systemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system.map(block => {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return '';
    return String(block.text ?? block.content ?? '');
  }).filter(Boolean).join('\n');
}

function serializedChars(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

const CONTEXT_MARKERS = Object.freeze({
  recentContinuity: '【最近对话连续性摘录｜接话前必须核对】',
  sessionSummary: '【当前窗口简介·早期聊天总结】',
  dailySummary: '【今日摘要】',
  openThreads: '【今天还没聊完的事】',
  stableMemory: '【永远记得的事（锁定记忆）】',
  relatedMemory: '【之前的记忆】',
  currentTurnGuard: '<ourhome_current_turn_guard>',
  rollingLedger: '<ourhome_context_ledger>',
});

function buildChatContextDiagnostics(body = {}, purpose = '') {
  const system = systemText(body.system);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUserIndex = messages.findLastIndex
    ? messages.findLastIndex(message => message?.role === 'user')
    : (() => {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (messages[index]?.role === 'user') return index;
        }
        return -1;
      })();

  const markers = {};
  for (const [name, marker] of Object.entries(CONTEXT_MARKERS)) {
    markers[name] = system.includes(marker);
  }

  return {
    purpose: String(purpose || '').slice(0, 40),
    model: String(body.model || '').slice(0, 80),
    totalChars: serializedChars(body),
    systemChars: system.length,
    messagesChars: serializedChars(messages),
    toolsChars: serializedChars(body.tools),
    messageCount: messages.length,
    lastUserIndex,
    tailRoles: messages.slice(-8).map(message => String(message?.role || '?').slice(0, 12)),
    markers,
  };
}

function formatChatContextDiagnostics(report = {}) {
  const markers = Object.entries(report.markers || {})
    .filter(([, present]) => present)
    .map(([name]) => name);
  const tail = Array.isArray(report.tailRoles) ? report.tailRoles.join('>') : '';
  return [
    '[chat:context-final]',
    'purpose=' + (report.purpose || 'unknown'),
    'model=' + (report.model || 'unknown'),
    'chars=' + (Number(report.totalChars) || 0),
    'system=' + (Number(report.systemChars) || 0),
    'messages=' + (Number(report.messagesChars) || 0),
    'tools=' + (Number(report.toolsChars) || 0),
    'messageCount=' + (Number(report.messageCount) || 0),
    'lastUserIndex=' + (Number.isInteger(report.lastUserIndex) ? report.lastUserIndex : -1),
    'tail=' + tail,
    'blocks=' + (markers.join(',') || 'none'),
  ].join(' ');
}

module.exports = {
  CONTEXT_MARKERS,
  systemText,
  buildChatContextDiagnostics,
  formatChatContextDiagnostics,
};
