'use strict';

// The Theater generator currently serializes recent raw turns into one large user
// prompt. Keep that prompt for backwards compatibility, but also expose the latest
// turns as real user/assistant messages. This gives the model an actual conversational
// history instead of asking it to recover dialogue from a memory-like text block.
const previousFetch = globalThis.fetch;
const MARKER = '【小剧场原始对话层·Raw Turns】';
const THEATER_RE = /OurHome 的[“"]小剧场[”"](?:长文|互动)写作引擎/u;
const RECENT_RE = /【最近互动记录】\s*([\s\S]*?)(?=\n【[^\n】]+刚刚发来】)/u;
const CURRENT_RE = /【([^\n】]+)刚刚发来】\s*([\s\S]*)$/u;

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => typeof item === 'string' ? item : item?.text || item?.content || '')
    .filter(Boolean).join('\n');
}

function isTheaterBody(body) {
  return Array.isArray(body?.messages)
    && body.messages.length > 0
    && THEATER_RE.test(textOf(body.system));
}

function splitHistoryEntries(text) {
  const raw = String(text || '').trim();
  if (!raw || raw === '（还没有正式开始。）') return [];
  return raw.split(/\n\n(?=[^\n]{1,80}：)/u)
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => {
      const match = item.match(/^([^：\n]{1,80})：([\s\S]*)$/u);
      if (!match) return null;
      return { label: match[1].trim(), text: match[2].trim() };
    })
    .filter(item => item?.text);
}

function buildStructuredMessages(body) {
  const lastIndex = body.messages.length - 1;
  const last = body.messages[lastIndex];
  const prompt = textOf(last?.content);
  if (!prompt || prompt.includes(MARKER)) return body;

  const recentMatch = prompt.match(RECENT_RE);
  const currentMatch = prompt.match(CURRENT_RE);
  if (!recentMatch || !currentMatch) return body;

  const entries = splitHistoryEntries(recentMatch[1]);
  const currentUserName = currentMatch[1].trim();
  const currentText = currentMatch[2].trim();
  if (!entries.length || !currentText) return body;

  const recentStart = prompt.indexOf('【最近互动记录】');
  const currentStart = currentMatch.index;
  if (recentStart < 0 || currentStart <= recentStart) return body;

  // Everything before the raw recent-history block is setup/background. Move it
  // into system so the real message array can represent the conversation itself.
  const setup = prompt.slice(0, recentStart).trim();
  const setupMarker = `${MARKER}\n以下是本轮小剧场的剧本、世界观、角色与较早剧情背景；它们用于理解当前场景，不替代下面的真实对话记录。`;
  let system = textOf(body.system);
  if (!system.includes(MARKER)) {
    system = `${system.trimEnd()}\n\n${setupMarker}\n${setup}`;
  }

  const historyMessages = [];
  for (const entry of entries) {
    const role = entry.label === currentUserName ? 'user' : 'assistant';
    const previousRole = historyMessages.at(-1)?.role;
    if (previousRole === role) {
      historyMessages[historyMessages.length - 1].content += `\n\n${entry.text}`;
    } else {
      historyMessages.push({ role, content: entry.text });
    }
  }

  if (!historyMessages.length) return body;
  const previousLast = historyMessages.at(-1);
  if (previousLast?.role === 'user') {
    const normalizedA = previousLast.content.replace(/\s+/gu, ' ').trim();
    const normalizedB = currentText.replace(/\s+/gu, ' ').trim();
    if (normalizedA === normalizedB) {
      return {
        ...body,
        system,
        messages: historyMessages,
      };
    }
    // Never create consecutive user messages. If the stored recent block ends
    // with a user turn, the current input is the continuation of that turn.
    previousLast.content = `${previousLast.content}\n\n${currentText}`;
    return {
      ...body,
      system,
      messages: historyMessages,
    };
  }

  historyMessages.push({ role: 'user', content: currentText });
  return {
    ...body,
    system,
    messages: historyMessages,
  };
}

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function theaterRawTurnsFetch(input, init = {}) {
    if (typeof init?.body !== 'string') return previousFetch(input, init);
    try {
      const body = JSON.parse(init.body);
      if (!isTheaterBody(body)) return previousFetch(input, init);
      const structured = buildStructuredMessages(body);
      return previousFetch(input, structured === body ? init : { ...init, body: JSON.stringify(structured) });
    } catch (error) {
      console.warn('[theater:raw-turns] skipped:', error.message);
      return previousFetch(input, init);
    }
  };
}

module.exports = {
  MARKER,
  isTheaterBody,
  splitHistoryEntries,
  buildStructuredMessages,
};