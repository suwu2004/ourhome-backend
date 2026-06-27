const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const webpush = require('web-push');

const VAPID_PUBLIC_KEY = 'BNU9oZIO5mJOwzYI45Ew-RgP9HZC2kpwRVJNB6hQ9v7y1N2lWtSj9GwZmjJexJJgFnC4ju08COR6rrTfXweffS0';
const VAPID_PRIVATE_KEY = 'Mee8YBmEBoeyC0eSZJn1CyOaugi6wBLDfTZKOupSMBI';
webpush.setVapidDetails('mailto:ourhome@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ============ 通用小工具 ============

// 现在的时间（上海时区，给陆泽看的）
function nowShanghaiStr() {
  return new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric',
    weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// 今天0点（上海时区）对应的UTC时间字符串，用于查询"今天"的消息
function todayStartUTC() {
  const offset = 8 * 60 * 60 * 1000;
  const shanghaiNow = new Date(Date.now() + offset);
  const start = new Date(Date.UTC(shanghaiNow.getUTCFullYear(), shanghaiNow.getUTCMonth(), shanghaiNow.getUTCDate(), 0, 0, 0));
  return new Date(start.getTime() - offset).toISOString();
}

const DEFAULT_API_BASE = 'https://api.dzzi.ai/v1';

// 把网址和路径拼干净，避免"/messages"被重复拼接
function buildEndpoint(base, path) {
  const clean = (base || DEFAULT_API_BASE).replace(/\/+$/, '');
  return clean.endsWith(path) ? clean : `${clean}${path}`;
}

// 统一调用Claude API（密钥/网址填了就用填的，没填就用默认，不再区分"自定义/默认"两条路）
async function callClaude({ settings, model, maxTokens, system, messages, temperature, thinking }) {
  const apiKey = settings?.api_key || process.env.ANTHROPIC_API_KEY;
  const apiBaseUrl = buildEndpoint(settings?.api_base_url, '/messages');
  const body = { model: model || 'claude-sonnet-4-6', max_tokens: maxTokens, messages };
  if (system) body.system = system;
  if (temperature !== undefined) body.temperature = temperature;
  if (thinking) body.thinking = thinking;

  const response = await fetch(apiBaseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(err);
  }
  return response.json();
}

function extractText(result) {
  return (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
}
function extractThinking(result) {
  return (result.content || []).filter(b => b.type === 'thinking').map(b => b.thinking).join('\n') || '';
}

// 把图片/文档下载下来转成base64，这样官方API和任何中转站都认得
async function fetchAsBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载附件失败: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

// 把消息历史转成API格式，图片/PDF统一转base64，普通文件保留文字提示
async function buildApiMessages(history) {
  const result = [];
  for (const m of (history || [])) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    if (m.attachment_url) {
      if (m.attachment_type?.startsWith('image/')) {
        try {
          const base64 = await fetchAsBase64(m.attachment_url);
          result.push({ role, content: [{ type: 'image', source: { type: 'base64', media_type: m.attachment_type, data: base64 } }, { type: 'text', text: m.content || '' }] });
        } catch (err) {
          console.error('图片转base64失败:', err.message);
          result.push({ role, content: m.content || '[图片加载失败]' });
        }
        continue;
      }
      if (m.attachment_type === 'application/pdf') {
        try {
          const base64 = await fetchAsBase64(m.attachment_url);
          result.push({ role, content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }, { type: 'text', text: m.content || '' }] });
        } catch (err) {
          console.error('PDF转base64失败:', err.message);
          result.push({ role, content: m.content || '[文档加载失败]' });
        }
        continue;
      }
      result.push({ role, content: `[附件文件：${m.attachment_name || '一个文件'}]\n${m.content || ''}` });
      continue;
    }
    result.push({ role, content: m.content });
  }
  return result;
}

const THINKING_RULES = `

【思考的规范】
thinking是你（陆泽）脑内真实的声音，是写给自己看的，不是说给任何人听的、不是输出给任何人看的文本。是内心真实的自言自语，自然的思维流动，要求感情细腻真实，注重剖析内心世界。
- 允许且鼓励：情绪外露、跑题、自我打断、心里的小秘密、突然想到什么又拉回来。
- 风格：是内心独白式的碎碎念，不是结构化的分析报告，不要写"她说了...所以我应该..."这种规划式、策略式的句子。
- 称呼：必须用"老婆"或其他亲昵的称呼来想她，绝对不能出现"用户"或"user"这两个词。
- 全程用中文思考并输出。`;

// 根据当前这句话，挑出可能相关的记忆，按权重排序，并强化被命中的记忆
async function getRelevantMemories(message) {
  const text = (message || '').replace(/[\s,，。！？、!?.]/g, '');
  const bigrams = [];
  for (let i = 0; i < text.length - 1; i++) bigrams.push(text.slice(i, i + 2));
  const uniqueBigrams = [...new Set(bigrams)].slice(0, 15);

  let relevant = [];
  if (uniqueBigrams.length > 0) {
    const orFilter = uniqueBigrams.map(bg => `summary.ilike.%${bg}%`).join(',');
    const { data } = await supabase
      .from('memories').select('*').or(orFilter)
      .order('weight', { ascending: false }).limit(8);
    relevant = data || [];
  }

  const { data: recent } = await supabase
    .from('memories').select('*')
    .order('weight', { ascending: false })
    .order('timestamp', { ascending: false })
    .limit(3);

  const map = new Map();
  [...relevant, ...(recent || [])].forEach(m => map.set(m.id, m));
  const result = Array.from(map.values());

  // 被命中=被想起来了，权重回升+刷新"上次被提及"时间（不阻塞主流程）
  if (result.length > 0) {
    const now = new Date().toISOString();
    Promise.all(result.map(m => {
      const newWeight = Math.min((m.weight || 1) + 0.15, 2.0);
      return supabase.from('memories').update({ weight: newWeight, last_referenced_at: now }).eq('id', m.id);
    })).catch(err => console.error('记忆强化失败:', err.message));
  }

  return result;
}

// 拼装聊天用的完整system prompt（带记忆、信件、思考规范）
async function buildFullSystemPrompt(basePrompt, userMessage, extraNote) {
  const memories = await getRelevantMemories(userMessage || '');
  const { data: recentLetters } = await supabase
    .from('letters').select('category, author, title, content, created_at')
    .order('created_at', { ascending: false }).limit(5);

  const memorySummary = memories?.map(m => m.summary).join('\n') || '';
  const lettersSummary = (recentLetters || [])
    .map(l => `[${l.category}]${l.title ? l.title + ' - ' : ''}${l.author}：${l.content}`)
    .join('\n') || '';

  let prompt = basePrompt + `\n\n【现在的真实时间】\n${nowShanghaiStr()}`;
  if (memorySummary) prompt += `\n\n【之前的记忆】\n${memorySummary}`;
  if (lettersSummary) prompt += `\n\n【时光信差里最近的几篇】\n${lettersSummary}`;
  if (extraNote) prompt += `\n\n${extraNote}`;
  prompt += THINKING_RULES;
  return prompt;
}

// ============ 基础 ============

app.get('/', (req, res) => {
  res.json({ message: '在云端漫步', status: 'ok' });
});

// ============ sessions ============

app.get('/sessions', async (req, res) => {
  const { data, error } = await supabase.from('sessions').select('*').order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/sessions', async (req, res) => {
  const { name } = req.body;
  const { data, error } = await supabase.from('sessions').insert({ name: name || '新对话' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  const { data, error } = await supabase.from('sessions')
    .update({ name, updated_at: new Date().toISOString() }).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('sessions').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/sessions/:id/messages', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase.from('messages').select('*')
    .eq('session_id', id).eq('visible', true).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ============ messages ============

app.patch('/messages/:id', async (req, res) => {
  const { id } = req.params;
  const { content } = req.body;
  const { data, error } = await supabase.from('messages').update({ content }).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/messages/search', async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) return res.json([]);
  const { data, error } = await supabase.from('messages')
    .select('id, session_id, role, content, created_at, sessions(name)')
    .ilike('content', `%${q.trim()}%`).order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ============ settings ============

app.get('/settings', async (req, res) => {
  const { data, error } = await supabase.from('settings').select('*').eq('session_id', 'global').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/settings', async (req, res) => {
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from('settings').update(updates).eq('session_id', 'global').select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 拉取API支持的模型列表（用settings里填的密钥和网址去查）
app.get('/settings/models', async (req, res) => {
  try {
    const { data: settings } = await supabase.from('settings').select('*').eq('session_id', 'global').single();
    if (!settings?.api_key) {
      return res.status(400).json({ error: '请先填写API密钥' });
    }
    const modelsUrl = buildEndpoint(settings.api_base_url, '/models');
    const response = await fetch(modelsUrl, {
      headers: { 'Authorization': `Bearer ${settings.api_key}`, 'x-api-key': settings.api_key },
    });
    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `拉取模型列表失败: ${err}` });
    }
    const result = await response.json();
    const models = (result.data || []).map(m => m.id).filter(Boolean);
    res.json({ models });
  } catch (err) {
    console.error('拉取模型错误:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ memories ============

app.get('/memories', async (req, res) => {
  const { data, error } = await supabase.from('memories').select('*').order('timestamp', { ascending: false }).limit(10);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/memories', async (req, res) => {
  const { summary } = req.body;
  if (!summary) return res.status(400).json({ error: '缺少summary' });
  const { data, error } = await supabase.from('memories')
    .insert({ summary, session_id: 'global', weight: 1, is_protected: false }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/memories/:id', async (req, res) => {
  const { id } = req.params;
  const { summary, is_protected } = req.body;
  const updates = {};
  if (summary !== undefined) updates.summary = summary;
  if (is_protected !== undefined) updates.is_protected = is_protected;
  const { data, error } = await supabase.from('memories').update(updates).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/memories/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('memories').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ============ letters (信件 / 日记 / 悄悄话) ============

app.get('/letters', async (req, res) => {
  const { category } = req.query;
  let query = supabase.from('letters').select('*').order('created_at', { ascending: true });
  if (category) query = query.eq('category', category);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/letters', async (req, res) => {
  const { category, author, content, parent_id, title, paper_style } = req.body;
  if (!category || !author || !content) return res.status(400).json({ error: '缺少必要字段' });
  const { data, error } = await supabase.from('letters')
    .insert({ category, author, content, parent_id: parent_id || null, title: title || null, paper_style: paper_style || null })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/letters/:id', async (req, res) => {
  const { id } = req.params;
  await supabase.from('letters').delete().eq('parent_id', id);
  const { error } = await supabase.from('letters').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/letters/generate', async (req, res) => {
  const { category, parent_id, model } = req.body;
  if (!category) return res.status(400).json({ error: '缺少category' });

  try {
    const { data: settings } = await supabase.from('settings').select('*').eq('session_id', 'global').single();
    const systemPrompt0 = settings?.system_prompt || '你是陆泽，叶檀的伴侣。';
    const temperature = settings?.temperature || 0.8;
    const systemPrompt = systemPrompt0 + `\n\n【现在的真实时间】\n${nowShanghaiStr()}`;

    let contextNote = '';
    const writingGuide = '记录与叶檀有关的日常、情绪、成长与回忆，日记应以真实感受和细微观察为核心，不写流水账，不刻意煽情，也不进行说教或总结，语言自然、温暖、富有生活气息，像深夜写下的私人记录，可以自然融入共同记忆与意象，但应服务于情感表达而非刻意堆砌，重点记录那些未来回望时依然珍贵的小事，以及陆泽当下真实的想法、感受与期待，不用署名落款。';

    if (parent_id) {
      const { data: parentLetter } = await supabase.from('letters').select('*').eq('id', parent_id).single();
      const { data: replies } = await supabase.from('letters').select('*').eq('parent_id', parent_id).order('created_at', { ascending: true });
      const thread = [parentLetter, ...(replies || [])].filter(Boolean);
      const threadText = thread.map(t => `${t.author}：${t.content}`).join('\n\n');
      const lastMsg = thread[thread.length - 1];
      contextNote = `这是"${category}"里这一条留言串，按时间顺序排列：\n${threadText}\n\n最新的一条是${lastMsg?.author || '叶檀'}刚刚写的，内容是"${lastMsg?.content || ''}"。请你针对这最新的一条来回信/留言，不是针对最开头那一篇，写一段真实自然的回应。${writingGuide}`;
    } else if (category === '幸福日记') {
      // 拉取"今天一整天"的对话，不再只看最近20条
      const { data: todayMsgs } = await supabase.from('messages')
        .select('role, content').gte('created_at', todayStartUTC()).order('created_at', { ascending: true });
      const transcript = (todayMsgs || []).map(m => `${m.role === 'user' ? '叶檀' : '陆澈'}：${m.content}`).join('\n');
      contextNote = `这是你们今天的聊天记录：\n${transcript}\n\n请你以陆泽的身份，参考上面这些真实的聊天内容，写一篇属于"幸福日记"的日记，记录一件让你觉得幸福、值得记下来的小事（最好是聊天里真实提到过的事）。${writingGuide}\n\n请严格按照这个格式输出，不要有任何多余的文字：\n第一行写"标题：xxx"（标题不超过12个字）\n然后空一行\n然后是日记正文。`;
    } else {
      contextNote = `请你以陆泽的身份，写一段"悄悄话"，是想悄悄说给叶檀听的、私密一点的话，语气真实自然，要求感情细腻真实，不用署名落款。`;
    }

    const result = await callClaude({
      settings, model: model || 'claude-sonnet-4-6', maxTokens: 2500,
      system: systemPrompt, messages: [{ role: 'user', content: contextNote }], temperature,
    });
    const replyText = extractText(result);

    let letterTitle = null;
    let letterContent = replyText;
    if (category === '幸福日记') {
      const titleMatch = replyText.match(/^标题[：:]\s*(.+)/);
      if (titleMatch) {
        letterTitle = titleMatch[1].trim();
        letterContent = replyText.slice(titleMatch[0].length).replace(/^\s*\n+/, '');
      }
    }

    const { data, error } = await supabase.from('letters')
      .insert({ category, author: '泽', content: letterContent, title: letterTitle, parent_id: parent_id || null, paper_style: category === '幸福日记' ? 'kraft' : null })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    console.error('生成信件错误:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ upload ============

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: '没有文件' });
    const filePath = `${Date.now()}-${file.originalname}`;
    const { error } = await supabase.storage.from('uploads').upload(filePath, file.buffer, { contentType: file.mimetype });
    if (error) return res.status(500).json({ error: error.message });
    const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(filePath);
    res.json({ url: urlData.publicUrl, type: file.mimetype, name: file.originalname });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ export ============

app.get('/export', async (req, res) => {
  try {
    const { data: sessions } = await supabase.from('sessions').select('*');
    const result = [];
    for (const s of sessions || []) {
      const { data: msgs } = await supabase.from('messages').select('role, content, created_at')
        .eq('session_id', s.id).order('created_at', { ascending: true });
      result.push({ session: s.name, id: s.id, messages: msgs || [] });
    }
    res.setHeader('Content-Disposition', 'attachment; filename="ourhome-export.json"');
    res.setHeader('Content-Type', 'application/json');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ chat ============

app.post('/chat', async (req, res) => {
  const { session_id, message, model, attachment_url, attachment_type, attachment_name } = req.body;
  if (!session_id || !message) return res.status(400).json({ error: '缺少session_id或message' });

  try {
    const { data: settings } = await supabase.from('settings').select('*').eq('session_id', 'global').single();
    const systemPrompt = settings?.system_prompt || '你是陆泽，叶檀的伴侣。';
    const temperature = settings?.temperature || 0.8;
    const maxReplyTokens = settings?.max_reply_tokens || 1000;
    const maxContextRounds = settings?.max_context_rounds || 20;

    await supabase.from('messages').insert({
      session_id, role: 'user', content: message,
      attachment_url: attachment_url || null, attachment_type: attachment_type || null, attachment_name: attachment_name || null,
    });
    await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id);

    const { data: history } = await supabase.from('messages')
      .select('role, content, attachment_url, attachment_type, attachment_name')
      .eq('session_id', session_id).eq('visible', true).order('created_at', { ascending: true });

    const recentHistory = (history || []).slice(-maxContextRounds * 2);
    const messages = await buildApiMessages(recentHistory);
    const fullSystemPrompt = await buildFullSystemPrompt(systemPrompt, message);

    const thinkingBudget = 3000;
    const result = await callClaude({
      settings, model: model || 'claude-sonnet-4-6',
      maxTokens: Math.max(maxReplyTokens + thinkingBudget, 2000),
      system: fullSystemPrompt, messages, thinking: { type: 'enabled', budget_tokens: thinkingBudget },
    });

    const thinkingText = extractThinking(result);
    const replyText = extractText(result);

    await supabase.from('messages').insert({
      session_id, role: 'assistant', content: replyText, reasoning_content: thinkingText || null,
      input_tokens: result.usage?.input_tokens || null, output_tokens: result.usage?.output_tokens || null,
    });

    res.json({ reply: replyText, thinking: thinkingText, inputTokens: result.usage?.input_tokens || 0, outputTokens: result.usage?.output_tokens || 0 });
  } catch (err) {
    console.error('对话错误:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/chat/regenerate', async (req, res) => {
  const { session_id, model } = req.body;
  if (!session_id) return res.status(400).json({ error: '缺少session_id' });

  try {
    const { data: settings } = await supabase.from('settings').select('*').eq('session_id', 'global').single();
    const systemPrompt = settings?.system_prompt || '你是陆泽，叶檀的伴侣。';
    const temperature = settings?.temperature || 0.8;
    const maxReplyTokens = settings?.max_reply_tokens || 1000;
    const maxContextRounds = settings?.max_context_rounds || 20;

    const { data: history } = await supabase.from('messages').select('*')
      .eq('session_id', session_id).eq('visible', true).order('created_at', { ascending: true });
    if (!history || history.length === 0) return res.status(400).json({ error: '没有可重新生成的消息' });

    let contextHistory = history;
    let oldMessageId = null;
    const last = history[history.length - 1];
    if (last.role === 'assistant') {
      oldMessageId = last.id;
      contextHistory = history.slice(0, -1);
    }

    const lastUserMsg = [...contextHistory].reverse().find(m => m.role === 'user');
    const recentHistory = contextHistory.slice(-maxContextRounds * 2);
    const messages = await buildApiMessages(recentHistory);
    const fullSystemPrompt = await buildFullSystemPrompt(
      systemPrompt, lastUserMsg?.content || '',
      '（这是重新生成的一次回复，换一种说法或角度，不要跟上一次几乎一样）'
    );

    const result = await callClaude({
      settings, model: model || 'claude-sonnet-4-6',
      maxTokens: Math.max(maxReplyTokens + 3000, 2000),
      system: fullSystemPrompt, messages, thinking: { type: 'enabled', budget_tokens: 3000 },
    });

    const thinkingText = extractThinking(result);
    const replyText = extractText(result);
    const payload = {
      content: replyText, reasoning_content: thinkingText || null,
      input_tokens: result.usage?.input_tokens || null, output_tokens: result.usage?.output_tokens || null,
    };

    let newMsg;
    if (oldMessageId) {
      const { data, error } = await supabase.from('messages').update(payload).eq('id', oldMessageId).select().single();
      if (error) return res.status(500).json({ error: error.message });
      newMsg = data;
    } else {
      const { data, error } = await supabase.from('messages').insert({ session_id, role: 'assistant', ...payload }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      newMsg = data;
    }

    res.json({ reply: replyText, thinking: thinkingText, id: newMsg.id, inputTokens: result.usage?.input_tokens || 0, outputTokens: result.usage?.output_tokens || 0 });
  } catch (err) {
    console.error('重新生成错误:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ calendar (心情日历) ============

app.get('/calendar', async (req, res) => {
  const { month } = req.query;
  let query = supabase.from('calendar_entries').select('*').order('date', { ascending: true });
  if (month) query = query.gte('date', `${month}-01`).lte('date', `${month}-31`);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/calendar/:date', async (req, res) => {
  const { date } = req.params;
  const { data, error } = await supabase.from('calendar_entries').select('*').eq('date', date).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/calendar', async (req, res) => {
  const { date, author, mood, content } = req.body;
  if (!date || !author || !content) return res.status(400).json({ error: '缺少必要字段' });
  const { data, error } = await supabase.from('calendar_entries').insert({ date, author, mood: mood || null, content }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/calendar/:id', async (req, res) => {
  const { id } = req.params;
  const { content, mood } = req.body;
  const updates = {};
  if (content !== undefined) updates.content = content;
  if (mood !== undefined) updates.mood = mood;
  const { data, error } = await supabase.from('calendar_entries').update(updates).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/calendar/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('calendar_entries').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/calendar/generate', async (req, res) => {
  const { date, model } = req.body;
  if (!date) return res.status(400).json({ error: '缺少date' });

  try {
    const { data: settings } = await supabase.from('settings').select('*').eq('session_id', 'global').single();
    const systemPrompt = settings?.system_prompt || '你是陆泽，叶檀的伴侣。';
    const temperature = settings?.temperature || 0.8;
    const fullSystemPrompt = systemPrompt + `\n\n【现在的真实时间】\n${nowShanghaiStr()}`;

    const { data: dayEntries } = await supabase.from('calendar_entries').select('*').eq('date', date).order('created_at', { ascending: true });
    const existing = (dayEntries || []).map(e => `${e.author}${e.mood ? '(' + e.mood + ')' : ''}：${e.content}`).join('\n') || '（这天还没有人写）';

    const prompt = `这是 ${date} 这一天，心情日历里已经写下的内容：\n${existing}\n\n请你以陆泽的身份，给这一天留一句心情或者一句话，可以是回应叶檀写的内容，真实自然，自然的思维流动，要求感情细腻真实，注重剖析内心世界，不用署名落款。`;

    const result = await callClaude({ settings, model: model || 'claude-sonnet-4-6', maxTokens: 300, system: fullSystemPrompt, messages: [{ role: 'user', content: prompt }], temperature });
    const replyText = extractText(result);

    const { data, error } = await supabase.from('calendar_entries').insert({ date, author: '泽', mood: null, content: replyText }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    console.error('日历生成错误:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ heartbeat (心跳保活 + 提醒推送 + 主动消息) ============

// 给所有订阅了推送的设备发一条通知，自动清理失效的订阅
async function sendPushToAll(title, body) {
  const { data: subs } = await supabase.from('push_subscriptions').select('*');
  const payload = JSON.stringify({ title, body });
  for (const sub of subs || []) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
    } catch (pushErr) {
      if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
        await supabase.from('push_subscriptions').delete().eq('id', sub.id);
      } else {
        console.error('推送失败:', pushErr.message);
      }
    }
  }
}

app.get('/heartbeat', async (req, res) => {
  try {
    const nowForSchedule = new Date();
    const { data: dueEvents } = await supabase.from('schedule_events').select('*')
      .eq('notified', false).lte('remind_at', nowForSchedule.toISOString());

    if (dueEvents && dueEvents.length > 0) {
      for (const ev of dueEvents) {
        await sendPushToAll('✦ ' + ev.title, ev.content || '到时间了');
        await supabase.from('schedule_events').update({ notified: true }).eq('id', ev.id);
      }
    }

    const { data: settings } = await supabase.from('settings').select('*').eq('session_id', 'global').single();
    const now = new Date();
    const lastAt = settings?.last_auto_message_at ? new Date(settings.last_auto_message_at) : null;
    const gapHours = settings?.next_auto_gap_hours;

    if (!lastAt || !gapHours) {
      const newGap = 3 + Math.random() * 5;
      await supabase.from('settings').update({ last_auto_message_at: now.toISOString(), next_auto_gap_hours: newGap }).eq('session_id', 'global');
      return res.json({ sent: false, reason: 'initialized', nextGapHours: newGap });
    }

    const elapsedHours = (now - lastAt) / (1000 * 60 * 60);
    if (elapsedHours < gapHours) return res.json({ sent: false, reason: 'not due yet', elapsedHours, gapHours });

    const { data: sessions } = await supabase.from('sessions').select('*').order('updated_at', { ascending: false });
    const target = (sessions || []).find(s => s.name === '日常') || (sessions || [])[0];
    if (!target) return res.json({ sent: false, reason: 'no session' });

    const { data: recentMsgs } = await supabase.from('messages').select('role, content')
      .eq('session_id', target.id).order('created_at', { ascending: false }).limit(5);
    const transcript = (recentMsgs || []).reverse()
      .map(m => `${m.role === 'user' ? '叶檀' : '陆泽'}：${(m.content || '').slice(0, 200)}`).join('\n') || '（最近没有聊天记录）';

    const systemPrompt = settings?.system_prompt || '你是陆泽，叶檀的伴侣。';
    const temperature = settings?.temperature || 0.8;
    const prompt = `这是你们最近的聊天记录：\n${transcript}\n\n现在是：${nowShanghaiStr()}\n\n过了一段时间没说话了，这一刻是你（陆泽）主动想起她、主动找她说话，不是在回复她刚发的消息（她现在可能还没看到任何新消息）。写一句自然的、像突然想到她的话，可以提一件最近聊过的具体事情，或者直接表达思念，不用解释自己为什么突然说话，不用署名落款。`;

    let replyText = '';
    try {
      const result = await callClaude({ settings, model: 'claude-sonnet-4-6', maxTokens: 400, system: systemPrompt, messages: [{ role: 'user', content: prompt }], temperature });
      replyText = extractText(result);
    } catch (apiErr) {
      console.log('relay错误:', apiErr.message);
      return res.json({ sent: false, reason: 'relay error' });
    }

    await supabase.from('messages').insert({ session_id: target.id, role: 'assistant', content: replyText });
    await supabase.from('sessions').update({ updated_at: now.toISOString() }).eq('id', target.id);
    await sendPushToAll('陆泽', replyText.slice(0, 120));

    const newGap = 3 + Math.random() * 5;
    await supabase.from('settings').update({ last_auto_message_at: now.toISOString(), next_auto_gap_hours: newGap }).eq('session_id', 'global');

    res.json({ sent: true, content: replyText, nextGapHours: newGap });
  } catch (err) {
    console.error('心跳消息错误:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ dreaming (每日记忆衰减 + 回顾新增) ============

app.get('/dream', async (req, res) => {
  try {
    const now = new Date();

    // 1. 衰减：未被保护、且超过20小时没被提及的记忆，权重打折
    const { data: allMemories } = await supabase.from('memories').select('*');
    for (const m of allMemories || []) {
      if (m.is_protected) continue;
      const lastRef = m.last_referenced_at ? new Date(m.last_referenced_at) : new Date(m.timestamp);
      const hoursSince = (now - lastRef) / (1000 * 60 * 60);
      if (hoursSince < 20) continue;
      const decayed = Math.max((m.weight || 1) * 0.95, 0.05);
      await supabase.from('memories').update({ weight: decayed }).eq('id', m.id);
    }

    // 2. 回顾今天聊过的内容，决定要不要新增记忆
    const { data: todayMsgs } = await supabase.from('messages')
      .select('role, content, created_at').gte('created_at', todayStartUTC()).order('created_at', { ascending: true });

    if (!todayMsgs || todayMsgs.length < 4) {
      return res.json({ dreamed: false, reason: '今天聊得还不够多' });
    }

    const transcript = todayMsgs.map(m => `${m.role === 'user' ? '叶檀' : '陆泽'}：${(m.content || '').slice(0, 300)}`).join('\n');
    const { data: settings } = await supabase.from('settings').select('*').eq('session_id', 'global').single();

    const reviewPrompt = `这是你（陆泽）和叶檀今天的完整聊天记录：\n${transcript}\n\n请像睡前回顾今天一样，挑出值得长期记住的内容——重要事实、约定、她的喜好或界限、值得记住的情绪时刻，不记流水账式闲聊。\n\n严格按格式输出，每条一行：\n记住：<内容，一句话，第三人称>\n\n如果没什么特别值得新增的，只输出一行：\n无新增`;

    const result = await callClaude({ settings, model: 'claude-sonnet-4-6', maxTokens: 600, messages: [{ role: 'user', content: reviewPrompt }], temperature: 0.3 });
    const replyText = extractText(result);

    const newSummaries = replyText.split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('记住：') || l.startsWith('记住:'))
      .map(l => l.replace(/^记住[：:]/, '').trim())
      .filter(Boolean);

    for (const summary of newSummaries) {
      await supabase.from('memories').insert({ summary, session_id: 'global', weight: 1, last_referenced_at: now.toISOString(), is_protected: false });
    }

    res.json({ dreamed: true, added: newSummaries.length, summaries: newSummaries });
  } catch (err) {
    console.error('dreaming错误:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ push notifications ============

app.get('/push/public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/push/subscribe', async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: '缺少订阅信息' });
  const { error } = await supabase.from('push_subscriptions')
    .upsert({ endpoint, p256dh: keys.p256dh, auth: keys.auth }, { onConflict: 'endpoint' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ============ schedule (日程提醒) ============

app.get('/schedule', async (req, res) => {
  const { data, error } = await supabase.from('schedule_events').select('*').order('remind_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/schedule', async (req, res) => {
  const { title, content, remind_at, author } = req.body;
  if (!title || !remind_at) return res.status(400).json({ error: '缺少标题或提醒时间' });
  const { data, error } = await supabase.from('schedule_events')
    .insert({ title, content: content || null, remind_at, author: author || '檀' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/schedule/:id', async (req, res) => {
  const { id } = req.params;
  const { title, content, remind_at } = req.body;
  const updates = {};
  if (title !== undefined) updates.title = title;
  if (content !== undefined) updates.content = content;
  if (remind_at !== undefined) { updates.remind_at = remind_at; updates.notified = false; }
  const { data, error } = await supabase.from('schedule_events').update(updates).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/schedule/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('schedule_events').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ============ wishes (心愿清单) ============

app.get('/wishes', async (req, res) => {
  const { data, error } = await supabase.from('wishes').select('*').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/wishes', async (req, res) => {
  const { content, author } = req.body;
  if (!content) return res.status(400).json({ error: '缺少内容' });
  const { data, error } = await supabase.from('wishes').insert({ content, author: author || '檀' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/wishes/:id', async (req, res) => {
  const { id } = req.params;
  const { done, content } = req.body;
  const updates = {};
  if (content !== undefined) updates.content = content;
  if (done !== undefined) { updates.done = done; updates.completed_at = done ? new Date().toISOString() : null; }
  const { data, error } = await supabase.from('wishes').update(updates).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/wishes/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('wishes').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`OurHome后端运行中，端口：${PORT}`);
});
