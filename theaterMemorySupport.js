'use strict';

const THEATER_MEMORY_CATEGORY = '小剧场记忆';
const THEATER_MEMORY_TITLE = '角色与剧情记忆';

function compactLine(value, max = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function compactBlock(value, max = 3000) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, max);
}

function formatTheaterTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function systemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system.map(block => typeof block === 'string' ? block : block?.text || block?.content || '').filter(Boolean).join('\n');
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => typeof block === 'string' ? block : block?.text || block?.content || '').filter(Boolean).join('\n');
}

function messageText(messages) {
  return (Array.isArray(messages) ? messages : []).map(message => contentText(message?.content)).filter(Boolean).join('\n\n');
}

function isInteractiveTheaterRequest(url, body) {
  if (!/\/messages(?:\?|$)/i.test(String(url || ''))) return false;
  const text = systemText(body?.system);
  return text.includes('OurHome 的“小剧场”互动写作引擎') && text.includes('独立小世界');
}

function extractTheaterRequestContext(body = {}) {
  const prompt = messageText(body.messages);
  const title = compactLine(prompt.match(/【剧本名】\s*\n([^\n]+)/u)?.[1], 80);
  const names = prompt.match(/【本书称呼】\s*\n([^\n：:]+)[：:]叶檀[^\n]*\n([^\n：:]+)[：:]/u);
  const latest = prompt.match(/【([^\n】]+)刚刚发来】\s*\n([\s\S]*?)\n\n【玩法】/u);
  return { title, userName: compactLine(names?.[1] || latest?.[1] || '叶檀', 40), assistantName: compactLine(names?.[2] || '剧场', 40), latestUserText: compactBlock(latest?.[2] || '', 5000), prompt };
}

function normalizeList(value, limit = 12, itemMax = 260) {
  const list = Array.isArray(value) ? value : String(value || '').split(/\n|；|;/u);
  return [...new Set(list.map(item => compactLine(item, itemMax)).filter(Boolean))].slice(0, limit);
}

function mergeTheaterFacts(previous = [], next = [], limit = 60) {
  const merged = [], seen = new Set();
  for (const raw of [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(next) ? next : [])]) {
    const item = compactLine(raw, 300);
    if (!item) continue;
    const key = item.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    if (!key || seen.has(key)) continue;
    seen.add(key); merged.push(item);
  }
  return merged.slice(Math.max(0, merged.length - Math.max(1, limit)));
}

function emptyTheaterMemory() {
  return { version: 3, character_anchor: '', character_memory: '', relationship_memory: '', plot_facts: [], current_state: '', open_threads: [], locked_notes: '', turns_since_refresh: 0, message_count: 0, last_message_id: null, updated_at: null, source: 'empty' };
}

function normalizeTheaterMemory(value = {}) {
  return {
    version: 3,
    character_anchor: compactBlock(value.character_anchor, 4600),
    character_memory: compactBlock(value.character_memory, 6000),
    relationship_memory: compactBlock(value.relationship_memory, 4200),
    plot_facts: normalizeList(value.plot_facts, 60, 300),
    current_state: compactBlock(value.current_state, 2400),
    open_threads: normalizeList(value.open_threads, 16, 280),
    locked_notes: compactBlock(value.locked_notes, 4200),
    turns_since_refresh: Math.max(0, Math.min(30, Number.parseInt(value.turns_since_refresh, 10) || 0)),
    message_count: Math.max(0, Number.parseInt(value.message_count, 10) || 0),
    last_message_id: value.last_message_id ? String(value.last_message_id) : null,
    updated_at: value.updated_at || null,
    source: compactLine(value.source, 40) || 'auto',
  };
}

function parseMemoryRow(row) {
  if (!row) return null;
  try { return { id: row.id, book_id: row.parent_id, ...normalizeTheaterMemory(JSON.parse(row.content || '{}')), created_at: row.created_at || null }; }
  catch { return { id: row.id, book_id: row.parent_id, ...normalizeTheaterMemory({ character_anchor: row.content || '' }), created_at: row.created_at || null }; }
}

function buildMemoryPromptBlock(memoryValue) {
  const memory = normalizeTheaterMemory(memoryValue || {}), sections = [];
  if (memory.locked_notes) sections.push(`【锁定记忆·不可自动改写】\n${memory.locked_notes}`);
  if (memory.character_anchor) sections.push(`【角色锚点】\n${memory.character_anchor}`);
  if (memory.character_memory) sections.push(`【角色长期记忆】\n这是剧情中已经确认、以后仍应记得的角色事实：习惯、偏好、能力、经历、伤病、物品、家人与社会关系等。它们不是当前动作，也不能因为离开最近对话窗口就遗忘。\n${memory.character_memory}`);
  if (memory.relationship_memory) sections.push(`【关系记忆】\n${memory.relationship_memory}`);
  if (memory.plot_facts.length) {
    const recentFacts = memory.plot_facts.slice(-36), archivedFacts = memory.plot_facts.slice(0, Math.max(0, memory.plot_facts.length - recentFacts.length));
    if (archivedFacts.length) sections.push(`【长期事件档案】\n这些都是已经发生过的旧剧情，按从早到晚理解，不能因为时间久就否认或改写。\n${archivedFacts.map(item => `- ${item}`).join('\n')}`);
    sections.push(`【近期核心剧情事实】\n以下事实按从早到晚理解，越靠后越新；如与当前状态冲突，以当前状态和本轮新剧情为准。\n${recentFacts.map(item => `- ${item}`).join('\n')}`);
  }
  if (memory.current_state) sections.push(`【当前场景状态·时间线最前沿】\n${memory.current_state}`);
  if (memory.open_threads.length) sections.push(`【未完成线索】\n${memory.open_threads.map(item => `- ${item}`).join('\n')}`);
  if (!sections.length) return '';
  return `【角色与剧情记忆】\n优先级：完整世界书与锁定记忆最高；角色锚点不能被临时情绪覆盖；角色长期记忆里的已确认事实不得无故遗忘；已发生剧情事实必须承认；当前状态代表时间线最前沿，除非剧情明确倒叙或回到过去，否则不能退回较早场景。\n${sections.join('\n\n')}`;
}

function injectMemoryIntoBody(body, memory) {
  const block = buildMemoryPromptBlock(memory);
  if (!block || !Array.isArray(body?.messages)) return body;
  const marker = '【角色与剧情记忆】';
  const messages = body.messages.map((message, index) => {
    if (index !== 0 || typeof message?.content !== 'string') return message;
    let text = message.content.replace(/\n*【角色与剧情记忆】[\s\S]*?(?=\n【较早剧情提要】|\n【最近互动记录】)/u, '');
    const insertionPoint = text.indexOf('\n【较早剧情提要】'), fallbackPoint = text.indexOf('\n【最近互动记录】'), point = insertionPoint >= 0 ? insertionPoint : fallbackPoint;
    text = point >= 0 ? `${text.slice(0, point)}\n\n${block}${text.slice(point)}` : `${text.trimEnd()}\n\n${block}`;
    return text.includes(marker) ? { ...message, content: text } : message;
  });
  return { ...body, messages };
}

function historyLine(row, userName = '叶檀', assistantName = '剧场') {
  const speaker = row?.author === '檀' || row?.role === 'user' ? userName : assistantName;
  const time = formatTheaterTime(row?.created_at);
  return `${time ? `【${time}】` : ''}${speaker}：${compactBlock(row?.content, 760)}`;
}

function sampleTheaterHistory(rows = [], options = {}) {
  const maxChars = Math.max(6000, Number(options.maxChars) || 42000), userName = options.userName || '叶檀', assistantName = options.assistantName || '剧场', list = Array.isArray(rows) ? rows : [];
  if (!list.length) return '';
  const firstCount = Math.min(12, list.length), lastCount = Math.min(40, Math.max(0, list.length - firstCount)), selected = new Set();
  for (let i = 0; i < firstCount; i += 1) selected.add(i);
  for (let i = Math.max(firstCount, list.length - lastCount); i < list.length; i += 1) selected.add(i);
  const middleStart = firstCount, middleEnd = Math.max(middleStart, list.length - lastCount), middleLength = middleEnd - middleStart, spreadCount = Math.min(28, middleLength);
  for (let i = 0; i < spreadCount; i += 1) { const index = middleStart + Math.floor(((i + 0.5) * middleLength) / spreadCount); if (index < middleEnd) selected.add(index); }
  const entries = [...selected].sort((a, b) => a - b).map(index => ({ index, line: `${index + 1}. ${historyLine(list[index], userName, assistantName)}` }));
  const complete = entries.map(entry => entry.line).join('\n');
  if (complete.length <= maxChars) return complete;
  const chosen = new Map(); let usedChars = 0;
  const add = entry => { if (!entry || chosen.has(entry.index)) return false; const cost = entry.line.length + (chosen.size ? 1 : 0); if (usedChars + cost > maxChars) return false; chosen.set(entry.index, entry); usedChars += cost; return true; };
  const latestBudget = Math.max(1, Math.floor(maxChars * 0.62)); let latestChars = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) { const entry = entries[i], cost = entry.line.length + (latestChars ? 1 : 0); if (latestChars && latestChars + cost > latestBudget) break; if (add(entry)) latestChars += cost; }
  add(entries[entries.length - 1]);
  const openingBudget = Math.max(1, Math.floor(maxChars * 0.18)); let openingChars = 0;
  for (const entry of entries) { if (chosen.has(entry.index)) continue; const cost = entry.line.length + (openingChars ? 1 : 0); if (openingChars && openingChars + cost > openingBudget) break; if (add(entry)) openingChars += cost; }
  for (const entry of entries) { if (!add(entry) && usedChars >= maxChars) break; }
  return [...chosen.values()].sort((a, b) => a.index - b.index).map(entry => entry.line).join('\n');
}

module.exports = { THEATER_MEMORY_CATEGORY, THEATER_MEMORY_TITLE, compactLine, compactBlock, systemText, contentText, messageText, isInteractiveTheaterRequest, extractTheaterRequestContext, normalizeList, mergeTheaterFacts, emptyTheaterMemory, normalizeTheaterMemory, parseMemoryRow, buildMemoryPromptBlock, injectMemoryIntoBody, historyLine, sampleTheaterHistory, formatTheaterTime };
