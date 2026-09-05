'use strict';

// Convert the serialized Theater history into real conversational turns while
// keeping original timestamps as explicit temporal metadata.
const previousFetch = globalThis.fetch;
const MARKER = '【小剧场原始对话层·Raw Turns】';
const TIME_MARKER = '【小剧场当前时间·Asia/Shanghai】';
const JUMP_MARKER = '【小剧场时间线·跳时规则】';
const THEATER_RE = /OurHome 的[“"]小剧场[”"](?:长文|互动)写作引擎/u;
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

function splitHistoryEntries(text) {
  const raw = String(text || '').trim();
  if (!raw || raw === '（还没有正式开始。）') return [];
  return raw.split(/\n\n(?=(?:\d+\.\s*)?(?:【[^】]+】)?[^\n]{1,80}：)/u)
    .map(item => item.trim()).filter(Boolean).map(item => {
      const match = item.match(/^(?:\d+\.\s*)?(?:【([^】]+)】)?([^：\n]{1,80})：([\s\S]*)$/u);
      if (!match) return null;
      return { timestamp: match[1] || null, label: match[2].trim(), text: match[3].trim() };
    }).filter(item => item?.text);
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
  const entries = splitHistoryEntries(recentMatch[1]), currentUserName = currentMatch[1].trim(), currentText = currentMatch[2].trim();
  if (!entries.length || !currentText) return body;
  const recentStart = prompt.indexOf('【最近互动记录】'), currentStart = currentMatch.index;
  if (recentStart < 0 || currentStart <= recentStart) return body;

  const setup = prompt.slice(0, recentStart).trim();
  let system = textOf(body.system);
  if (!system.includes(MARKER)) system = `${system.trimEnd()}\n\n${buildTimelineInstruction()}\n\n${MARKER}\n以下是本轮小剧场的剧本、世界观、角色与较早剧情背景；它们用于理解当前场景，不替代下面按时间顺序排列的真实对话。\n${setup}`;

  const historyMessages = [];
  for (const entry of entries) {
    const role = entry.label === currentUserName || entry.label.includes(currentUserName) ? 'user' : 'assistant';
    const previousRole = historyMessages.at(-1)?.role;
    const stamp = entry.timestamp ? `【历史剧情时间：${entry.timestamp}（Asia/Shanghai）】\n` : '';
    if (previousRole === role) historyMessages[historyMessages.length - 1].content += `\n\n${stamp}${entry.text}`;
    else historyMessages.push({ role, content: `${stamp}${entry.text}` });
  }
  if (!historyMessages.length) return body;

  const currentStamp = `【当前剧情时间待判定】\n${currentText}`;
  const previousLast = historyMessages.at(-1);
  if (previousLast?.role === 'user') {
    const normalizedA = previousLast.content.replace(TIME_PREFIX_RE, '').replace(/\s+/gu, ' ').trim();
    const normalizedB = currentText.replace(/\s+/gu, ' ').trim();
    if (normalizedA.endsWith(normalizedB)) return { ...body, system, messages: historyMessages };
    previousLast.content = `${previousLast.content}\n\n${currentStamp}`;
    return { ...body, system, messages: historyMessages };
  }
  historyMessages.push({ role: 'user', content: currentStamp });
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

module.exports = { MARKER, TIME_MARKER, JUMP_MARKER, isTheaterBody, splitHistoryEntries, buildStructuredMessages, currentShanghaiTime, buildTimelineInstruction };
