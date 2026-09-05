'use strict';

// Turn the Theater prompt's recent-history block into actual conversational turns.
// Keep absolute timestamps attached to every turn so the model can distinguish
// present, earlier scenes, and explicit flashbacks instead of relying on summaries.
const previousFetch = globalThis.fetch;
const MARKER = '【小剧场原始对话层·Raw Turns】';
const TIME_MARKER = '【小剧场当前时间·Asia/Shanghai】';
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
  return Array.isArray(body?.messages) && body.messages.length > 0 && THEATER_RE.test(textOf(body.system));
}

function splitHistoryEntries(text) {
  const raw = String(text || '').trim();
  if (!raw || raw === '（还没有正式开始。）') return [];
  return raw.split(/\n\n(?=(?:\d+\.\s*)?(?:【[^】]+】)?[^\n]{1,80}：)/u)
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => {
      const match = item.match(/^(?:\d+\.\s*)?(?:【[^】]+】)?([^：\n]{1,80})：([\s\S]*)$/u);
      if (!match) return null;
      return { label: match[1].trim(), text: match[2].trim() };
    })
    .filter(item => item?.text);
}

function currentShanghaiTime() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
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

  const setup = prompt.slice(0, recentStart).trim();
  const timeInstruction = `${TIME_MARKER}\n现在是 ${currentShanghaiTime()}（北京时间，Asia/Shanghai）。这是模型收到本轮请求时的真实当前时间。历史对话中的时间优先服从每条消息自己的时间戳；“今天/昨天/刚才”等相对时间必须以这里的当前时间和对应历史时间为基准重新判断。除非剧情明确发生倒叙、回忆或时间跳跃，不得把旧消息当成当前正在发生。`;
  const setupMarker = `${MARKER}\n以下是本轮小剧场的剧本、世界观、角色与较早剧情背景；它们用于理解当前场景，不替代下面按时间顺序排列的真实对话。`;
  let system = textOf(body.system);
  if (!system.includes(MARKER)) system = `${system.trimEnd()}\n\n${timeInstruction}\n\n${setupMarker}\n${setup}`;

  const historyMessages = [];
  for (const entry of entries) {
    const role = entry.label === currentUserName || entry.label.includes(currentUserName) ? 'user' : 'assistant';
    const previousRole = historyMessages.at(-1)?.role;
    const content = entry.text;
    if (previousRole === role) historyMessages[historyMessages.length - 1].content += `\n\n${content}`;
    else historyMessages.push({ role, content });
  }
  if (!historyMessages.length) return body;

  const previousLast = historyMessages.at(-1);
  if (previousLast?.role === 'user') {
    const normalizedA = previousLast.content.replace(/\s+/gu, ' ').trim();
    const normalizedB = currentText.replace(/\s+/gu, ' ').trim();
    if (normalizedA === normalizedB) return { ...body, system, messages: historyMessages };
    previousLast.content = `${previousLast.content}\n\n${currentText}`;
    return { ...body, system, messages: historyMessages };
  }

  historyMessages.push({ role: 'user', content: currentText });
  return { ...body, system, messages: historyMessages };
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

module.exports = { MARKER, TIME_MARKER, isTheaterBody, splitHistoryEntries, buildStructuredMessages, currentShanghaiTime };
