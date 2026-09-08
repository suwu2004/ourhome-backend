'use strict';

// Convert serialized Theater history into real conversational turns while
// keeping original timestamps as explicit temporal metadata.
const previousFetch = globalThis.fetch;
const MARKER = '【小剧场原始对话层·Raw Turns】';
const TIME_MARKER = '【小剧场当前时间·Asia/Shanghai】';
const JUMP_MARKER = '【小剧场时间线·跳时规则】';
const CONTEXT_MARKER = '【小剧场请求上下文】';
const THEATER_RE = /OurHome 的[“\"]小剧场[”\"](?:长文|互动)写作引擎/u;
const RECENT_MESSAGE_WINDOW = 18;
const RECENT_RE = /【最近互动记录】\s*([\s\S]*?)(?=\n【[^\n】]+刚刚发来】)/u;
const CURRENT_RE = /【([^\n】]+)刚刚发来】\s*([\s\S]*)$/u;
const TIME_PREFIX_RE = /^【历史剧情时间：[^】]+】\n/u;

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('\n');
}

function isTheaterBody(body) {
  return Array.isArray(body?.messages) && body.messages.length > 0 && THEATER_RE.test(textOf(body.system));
}

function parseHistoryChunk(item) {
  const match = String(item || '').trim().match(/^(?:\s*\d+\.\s*)?(?:【([^】]+)】)?([^：\n]{1,80})：([\s\S]*)$/u);
  if (!match) return null;
  return { timestamp: match[1] || null, label: match[2].trim(), text: match[3].trim() };
}

function splitHistoryEntries(text) {
  const raw = String(text || '').trim();
  if (!raw || raw === '（还没有正式开始。）') return [];

  // Numbered history is unambiguous. Unnumbered history is split at every
  // speaker label so one turn cannot swallow the following turn.
  if (/^\s*\d+\.\s*/u.test(raw)) {
    return raw.split(/\n(?=\s*\d+\.\s*)/u).map(parseHistoryChunk).filter(Boolean);
  }

  return raw
    .split(/\n\s*(?=(?:【[^】]+】)?[^：\n]{1,80}：)/u)
    .map(parseHistoryChunk)
    .filter(Boolean);
}

function currentShanghaiTime() {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date());
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function buildTimelineInstruction() {
  return `${TIME_MARKER}\n现在是 ${currentShanghaiTime()}（北京时间，Asia/Shanghai）。这是本轮请求的现实时间锚点。\n\n${JUMP_MARKER}\n默认：严格承接最近一次正在发生的剧情，不把旧消息误当成现在。\n允许：用户明确说“第二天、几天后、半年后、十年后、多年以后、后来、回到三年前、回忆起、与此同时、镜头转到”等时间跳跃、倒叙或平行场景时，立即建立新的剧情时间点并继续演绎。\n规则：时间跳跃后的后续剧情默认沿用新的时间点；明确回忆/倒叙属于临时过去场景，不自动覆盖主时间线；“与此同时”可以建立并行场景，不把两地事件强行合并成同一时刻。\n如果用户只使用模糊的“过了一会儿/后来”而没有明确跨度，只做自然、短距离推进，不擅自跨越数月或数年。\n如果旧整理记忆与最近真实对话冲突，以最近真实对话和本轮明确时间跳跃为准。`;
}

function buildStructuredMessages(body) {
  const lastIndex = body.messages.length - 1, last = body.messages[lastIndex], prompt = textOf(last?.content);
  if (!prompt || prompt.includes(MARKER)) return body;
  const recentMatch = prompt.match(RECENT_RE), currentMatch = prompt.match(CURRENT_RE);
  if (!recentMatch || !currentMatch) return body;
  const entries = splitHistoryEntries(recentMatch[1]);
  const currentUserName = currentMatch[1].trim();
  const currentText = currentMatch[2].trim();
  if (!currentText) return body;
  const recentStart = prompt.indexOf('【最近互动记录】'), currentStart = currentMatch.index;
  if (recentStart < 0 || currentStart <= recentStart) return body;

  const setup = prompt.slice(0, recentStart).trim();
  let system = textOf(body.system);
  const bookTitle = setup.match(/【剧本名】\s*\n([^\n]+)/u)?.[1]?.trim() || '';
  const nameBlock = setup.match(/【本书称呼】\s*\n([^\n：:]+)[：:]叶檀[^\n]*\n([^\n：:]+)[：:]/u);
  const assistantName = nameBlock?.[2]?.trim() || '';
  if (!system.includes(MARKER)) {
    system = `${system.trimEnd()}\n\n${buildTimelineInstruction()}\n\n${CONTEXT_MARKER}\n剧本名：${bookTitle}\n玩家：${currentUserName}\n本书角色：${assistantName || '剧场'}\n本轮玩家输入：${currentText.slice(0, 6000)}\n\n以下原始对话会作为真实历史消息直接提供给模型；不要把它改写成摘要，也不要制造第二套连续性锚点。\n${setup}`;
  }

  const historyMessages = [];
  for (const entry of entries) {
    const role = entry.label === currentUserName || entry.label.includes(currentUserName) ? 'user' : 'assistant';
    const previousRole = historyMessages.at(-1)?.role;
    const stamp = entry.timestamp ? `【历史剧情时间：${entry.timestamp}（Asia/Shanghai）】\n` : '';
    if (previousRole === role) historyMessages[historyMessages.length - 1].content += `\n\n${stamp}${entry.text}`;
    else historyMessages.push({ role, content: `${stamp}${entry.text}` });
  }

  if (!historyMessages.length) return body;

  // Every request is a new user turn. Keep it as a distinct message instead
  // of merging it into the previous user turn. This preserves the exact
  // user -> assistant -> user boundary that the provider uses for continuity.
  historyMessages.push({ role: 'user', content: `【当前剧情时间待判定】\n${currentText}` });

  // Enforce the context window after raw history expansion. Always keep the
  // current user message and the immediately preceding assistant turn when
  // one exists; never replace missing history with a summary/anchor.
  let recentMessages = historyMessages.length > RECENT_MESSAGE_WINDOW
    ? historyMessages.slice(-RECENT_MESSAGE_WINDOW)
    : historyMessages;
  const currentMessage = recentMessages.at(-1);
  if (currentMessage?.role !== 'user') {
    recentMessages = [...recentMessages, historyMessages.at(-1)];
  }
  if (recentMessages.length > 1 && recentMessages.at(-2)?.role !== 'assistant') {
    const previousAssistant = [...historyMessages].reverse().find((message, index) => index > 0 && message.role === 'assistant');
    if (previousAssistant && !recentMessages.includes(previousAssistant)) {
      recentMessages = [previousAssistant, ...recentMessages].slice(-RECENT_MESSAGE_WINDOW);
    }
  }

  return { ...body, system, messages: recentMessages };
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

module.exports = { MARKER, TIME_MARKER, JUMP_MARKER, CONTEXT_MARKER, RECENT_MESSAGE_WINDOW, isTheaterBody, splitHistoryEntries, buildStructuredMessages, currentShanghaiTime, buildTimelineInstruction };
