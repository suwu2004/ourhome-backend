'use strict';

// This guard is loaded after apiUsageAuditPatch. Local background maintenance is
// handled before it reaches the audited/provider transport, so zero-cost work does
// not appear as a paid API call. When the owner explicitly configures a dedicated
// model, the request is passed through with a purpose label for the audit log.
const providerFetch = globalThis.fetch;

function safeBody(init = {}) {
  if (typeof init?.body !== 'string') return null;
  try { return JSON.parse(init.body); } catch { return null; }
}

function messageText(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map(message => {
      if (typeof message?.content === 'string') return message.content;
      if (!Array.isArray(message?.content)) return '';
      return message.content.map(block => block?.text || '').filter(Boolean).join('\n');
    })
    .join('\n');
}

function isMemoryJournalRequest(body) {
  return Boolean(body?.model)
    && messageText(body?.messages).includes('请为 OurHome 的记忆日志分析刚刚这一轮聊天');
}

function compact(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractBetween(text, start, end) {
  const from = text.indexOf(start);
  if (from < 0) return '';
  const rest = text.slice(from + start.length);
  const to = end ? rest.indexOf(end) : -1;
  return (to >= 0 ? rest.slice(0, to) : rest).trim();
}

function localMemoryJournal(body) {
  const prompt = messageText(body?.messages);
  const existing = compact(extractBetween(prompt, '【今天已有摘要】', '【未收尾话题】'), 900);
  const turn = extractBetween(prompt, '【刚刚这一轮】', '请只输出 JSON');
  const userText = compact(extractBetween(turn, '叶檀：', '陆泽：'), 500);
  const assistantText = compact(extractBetween(turn, '陆泽：', ''), 500);
  const signal = `${userText} ${assistantText}`;
  const shouldContinue = /(继续|待会|之后|稍后|明天|下次|记得|别忘|部署|上线|报错|失败|修复|优化|修改|检查|问题|计划|待办|还没|没有解决|再看|再改|再试)/i.test(signal);
  const markSummary = compact(userText || assistantText, 120);
  const latest = compact([
    userText ? `叶檀：${userText}` : '',
    assistantText ? `陆泽：${assistantText}` : '',
  ].filter(Boolean).join('；'), 420);
  const dailySummary = compact([
    existing && existing !== '无' ? existing : '',
    latest ? `本轮：${latest}` : '',
  ].filter(Boolean).join('；'), 900);

  return {
    mark: {
      topic: compact(userText, 60),
      emotion: '',
      summary: shouldContinue ? markSummary : '',
      importance: shouldContinue ? 3 : 1,
      should_continue: shouldContinue,
      should_remember: false,
      tags: [],
    },
    daily_summary: {
      summary: dailySummary,
      highlights: [],
      open_threads: shouldContinue && markSummary ? [markSummary] : [],
      mood: '',
    },
    long_memory: {
      should_save: false,
      summary: '',
    },
  };
}

function localAnthropicResponse(payload) {
  return new Response(JSON.stringify({
    id: `ourhome-local-memory-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    model: 'ourhome-local-memory-journal',
    stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-OurHome-Local-Response': 'memory-journal' },
  });
}

if (typeof providerFetch === 'function') {
  globalThis.fetch = async function backgroundAiCostGuardFetch(input, init = {}) {
    const body = safeBody(init);
    if (!isMemoryJournalRequest(body)) return providerFetch(input, init);

    const dedicatedModel = String(process.env.MEMORY_JOURNAL_MODEL || '').trim();
    if (!dedicatedModel) {
      console.log('[cost-guard] memory journal handled locally (0 provider calls)');
      return localAnthropicResponse(localMemoryJournal(body));
    }

    const headers = new Headers(init?.headers || undefined);
    headers.set('X-OurHome-Call-Purpose', 'memory-journal');
    const nextBody = { ...body, model: dedicatedModel };
    console.log(`[cost-guard] memory journal uses explicit model=${dedicatedModel}`);
    return providerFetch(input, { ...init, headers, body: JSON.stringify(nextBody) });
  };
}

module.exports = {
  isMemoryJournalRequest,
  localMemoryJournal,
};
