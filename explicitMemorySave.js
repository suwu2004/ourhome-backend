'use strict';

function normalizeExplicitMemorySummary(value) {
  const summary = String(value ?? '').replace(/\\s+/g, ' ').trim();
  if (!summary) {
    return { ok: false, error: '记忆内容不能为空，尚未保存。' };
  }
  if (summary.length < 8) {
    return { ok: false, error: '这条记忆太短，请补全成一条可以理解的事实。' };
  }
  if (summary.length > 260) {
    return { ok: false, error: '这条记忆太长，请整理成一句不超过260字的稳定事实。' };
  }
  return { ok: true, summary };
}

module.exports = { normalizeExplicitMemorySummary };
