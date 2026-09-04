'use strict';

// The Theater chat prompt already contains a recent-history block, but that block
// can sit behind a large worldbook/memory payload. Keep the literal latest few raw
// turns at the very end of the user prompt so the model cannot mistake an older
// checkpoint for the live scene. This is a prompt-order guard only: it does not
// create, delete, or rewrite any Theater history.
const previousFetch = globalThis.fetch;
const MARKER = '【最近互动硬保底·Theater Live Turn】';
const THEATER_SYSTEM_RE = /OurHome 的?[“"]?小剧场[”"]?互动写作引擎/u;
const RECENT_BLOCK_RE = /【最近互动记录】\s*([\s\S]*?)(?=\n【[^\n】]+刚刚发来】)/u;

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => typeof block === 'string' ? block : block?.text || block?.content || '')
    .filter(Boolean).join('\n');
}

function systemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system.map(block => typeof block === 'string' ? block : block?.text || block?.content || '')
    .filter(Boolean).join('\n');
}

function isTheaterProviderRequest(url, body) {
  return /\/messages(?:\?|$)/i.test(String(url || ''))
    && THEATER_SYSTEM_RE.test(systemText(body?.system))
    && Array.isArray(body?.messages)
    && body.messages.length > 0;
}

function extractLatestHistoryEntries(prompt, maxEntries = 4) {
  const match = String(prompt || '').match(RECENT_BLOCK_RE);
  if (!match?.[1]) return [];
  const raw = match[1].trim();
  if (!raw || raw === '（还没有正式开始。）') return [];
  const chunks = raw.split(/\n\n(?=[^\n]{1,60}：)/u).map(item => item.trim()).filter(Boolean);
  return chunks.slice(-maxEntries);
}

function guardTheaterBody(body) {
  if (!isTheaterProviderRequest('', body)) return body;
  const messages = body.messages.map(message => ({ ...message }));
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  const prompt = contentText(last?.content);
  if (!prompt || prompt.includes(MARKER)) return body;
  const entries = extractLatestHistoryEntries(prompt, 4);
  if (!entries.length) return body;

  const currentMarker = prompt.lastIndexOf('【叶檀刚刚发来】');
  const latestLabel = currentMarker >= 0 ? prompt.slice(currentMarker) : '';
  if (!latestLabel) return body;

  const prefix = prompt.slice(0, currentMarker).replace(/\s+$/u, '');
  const currentBlock = latestLabel.trim();
  const guard = `${MARKER}\n以下是数据库里已经发生的最近真实剧情，仅用于确保你从当前场景继续，不得把它当成新的玩家输入：\n${entries.join('\n\n')}`;
  messages[lastIndex] = {
    ...last,
    content: `${prefix}\n\n${guard}\n\n${currentBlock}`,
  };
  return { ...body, messages };
}

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function theaterLiveTurnGuardFetch(input, init = {}) {
    if (typeof init?.body !== 'string') return previousFetch(input, init);
    try {
      const body = JSON.parse(init.body);
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
      if (!isTheaterProviderRequest(url, body)) return previousFetch(input, init);
      const guarded = guardTheaterBody(body);
      return previousFetch(input, guarded === body ? init : { ...init, body: JSON.stringify(guarded) });
    } catch (error) {
      console.warn('[theater:live-turn] request guard skipped:', error.message);
      return previousFetch(input, init);
    }
  };
}

module.exports = {
  MARKER,
  isTheaterProviderRequest,
  extractLatestHistoryEntries,
  guardTheaterBody,
};
