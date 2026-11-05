'use strict';

// Keep session-summary provider usage bounded without copying raw dialogue into the summary.
const previousFetch = globalThis.fetch;
const MAX_MODEL_CHUNKS = 4;
const SUMMARY_PATH_RE = /\\/sessions\\/[^/]+\\/summary(?:$|[?#])/i;
const TOPIC_LABELS = [
  ['OurHome 项目与开发', /OurHome|前端|后端|GitHub|Render|Vercel|Supabase|数据库|部署|代码|接口|API|记忆系统/iu],
  ['工作与职业', /工作|上班|辞职|面试|求职|工资|同事|公司|职业/iu],
  ['教学与学校', /教学|老师|学生|课堂|课表|备课|作文|论文|学校|考试/iu],
  ['家庭与人际关系', /家人|妈妈|爸爸|父母|朋友|同事|关系/iu],
  ['情绪与陪伴', /难过|开心|委屈|焦虑|担心|压力|安慰|陪伴|哭|情绪/iu],
  ['生活计划与待办', /计划|准备|打算|决定|安排|待办|下一步|完成|进度/iu],
  ['兴趣与日常', /小说|音乐|散步|画画|游戏|电影|吃饭|旅行|天气/iu],
  ['健康与作息', /身体|睡眠|休息|疼|生病|医院|运动|饮食/iu],
];
const ROLEPLAY_RE = /(?:（[^）]{1,100}）|\\*[^*]{1,100}\\*|亲亲|抱抱|蹭蹭|吻|低头|抬手|贴近|搂住|怀里|耳边|脸颊)/u;

function compact(value, max = 900) {
  return String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
}

function extractPrompt(body) {
  const parts = [];
  if (typeof body?.system === 'string') parts.push(body.system);
  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      if (typeof message?.content === 'string') parts.push(message.content);
      else if (Array.isArray(message?.content)) {
        for (const item of message.content) if (typeof item?.text === 'string') parts.push(item.text);
      }
    }
  }
  return parts.join('\\n');
}

function selectedModelChunkIndexes(total, max = MAX_MODEL_CHUNKS) {
  const count = Math.max(0, Math.floor(Number(total) || 0));
  const limit = Math.max(0, Math.floor(Number(max) || 0));
  if (!count || !limit) return [];
  if (count <= limit) return Array.from({ length: count }, (_, index) => index + 1);
  if (limit === 1) return [Math.ceil(count / 2)];
  const selected = new Set();
  for (let index = 0; index < limit; index += 1) {
    selected.add(Math.round(index * (count - 1) / (limit - 1)) + 1);
  }
  return [...selected].sort((a, b) => a - b);
}

function localChunkDigest(prompt) {
  const match = String(prompt || '').match(/聊天段落：\\s*([\\s\\S]*?)\\s*输出不超过260字/);
  const text = match?.[1] || '';
  const lines = text.split('\\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) return '本段聊天没有可提取的正文。';

  // Deliberately never include message bodies: local fallback is metadata-only.
  // This prevents roleplay, private dialogue, or long user messages being pasted
  // verbatim into a supposedly concise session summary.
  const messageLines = lines.filter(line => /(?:叶檀|陆泽)：/.test(line));
  const topicText = messageLines.join(' ');
  const topics = TOPIC_LABELS.filter(([, pattern]) => pattern.test(topicText)).map(([label]) => label);
  const roleplayLines = messageLines.filter(line => ROLEPLAY_RE.test(line));
  const isMostlyRoleplay = messageLines.length > 0 && roleplayLines.length / messageLines.length >= 0.45;
  const firstTime = lines[0].match(/(\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2})/)?.[1] || '';
  const lastTime = lines[lines.length - 1].match(/(\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2})/)?.[1] || '';
  const timeRange = firstTime && lastTime ? `时间范围 ${firstTime} 至 ${lastTime}` : '';
  const topicTextLabel = topics.length ? `涉及主题：${topics.slice(0, 4).join('、')}` : '未识别出明确的长期主题';
  const styleLabel = isMostlyRoleplay
    ? '本段以情境互动和情绪陪伴为主，不保留逐句台词或动作描写'
    : '本段为较早对话的概览片段，未逐条保留原始发言';
  return compact(`本段约含 ${messageLines.length} 条对话消息；${timeRange}；${topicTextLabel}；${styleLabel}。`, 420);
}

function syntheticAnthropicResponse(text) {
  const body = JSON.stringify({
    id: `local-summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'message', role: 'assistant', model: 'ourhome-local-summary',
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: Math.ceil(String(text).length / 2) },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function sessionSummaryEconomyFetch(input, init = {}) {
    let body = null;
    try {
      if (typeof init?.body === 'string') body = JSON.parse(init.body);
    } catch (error) {
      console.warn('[session-summary:economy] request inspection skipped:', error.message);
    }

    const url = typeof input === 'string' ? input : input?.url || '';
    const prompt = body ? extractPrompt(body) : '';
    const match = prompt.match(/第\\s*(\\d+)\\/(\\d+)\\s*段聊天记录/);
    if (match) {
      const chunkIndex = Number(match[1]);
      const total = Number(match[2]);
      const modelChunks = selectedModelChunkIndexes(total);
      if (Number.isFinite(chunkIndex) && Number.isFinite(total) && !modelChunks.includes(chunkIndex)) {
        console.log(`[session-summary:economy] metadata digest chunk ${chunkIndex}/${total} (provider call skipped)`);
        return syntheticAnthropicResponse(localChunkDigest(prompt));
      }
    }

    // Non-chunk summary calls continue normally for the final synthesis.
    return previousFetch(input, init);
  };
}

module.exports = { localChunkDigest, selectedModelChunkIndexes };
