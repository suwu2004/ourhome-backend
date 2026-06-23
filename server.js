const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.get('/', (req, res) => {
  res.json({ message: '在云端漫步', status: 'ok' });
});

// ---------- sessions ----------

app.get('/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/sessions', async (req, res) => {
  const { name } = req.body;
  const { data, error } = await supabase
    .from('sessions')
    .insert({ name: name || '新对话' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  const { data, error } = await supabase
    .from('sessions')
    .update({ name, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
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
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('session_id', id)
    .eq('visible', true)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---------- messages ----------

app.patch('/messages/:id', async (req, res) => {
  const { id } = req.params;
  const { content } = req.body;
  const { data, error } = await supabase
    .from('messages')
    .update({ content })
    .eq('id', id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---------- settings ----------

app.get('/settings', async (req, res) => {
  const { data, error } = await supabase
    .from('settings')
    .select('*')
    .eq('session_id', 'global')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/settings', async (req, res) => {
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  const { data, error } = await supabase
    .from('settings')
    .update(updates)
    .eq('session_id', 'global')
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---------- memories ----------

app.get('/memories', async (req, res) => {
  const { data, error } = await supabase
    .from('memories')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(10);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/memories', async (req, res) => {
  const { summary } = req.body;
  if (!summary) {
    return res.status(400).json({ error: '缺少summary' });
  }
  const { data, error } = await supabase
    .from('memories')
    .insert({ summary, session_id: 'global' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/memories/:id', async (req, res) => {
  const { id } = req.params;
  const { summary } = req.body;
  const { data, error } = await supabase
    .from('memories')
    .update({ summary })
    .eq('id', id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/memories/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('memories').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ---------- letters ----------

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
  if (!category || !author || !content) {
    return res.status(400).json({ error: '缺少必要字段' });
  }
  const { data, error } = await supabase
    .from('letters')
    .insert({ category, author, content, parent_id: parent_id || null, title: title || null, paper_style: paper_style || null })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/letters/generate', async (req, res) => {
  const { category, parent_id } = req.body;
  if (!category) {
    return res.status(400).json({ error: '缺少category' });
  }
  try {
    const { data: settings } = await supabase
      .from('settings')
      .select('*')
      .eq('session_id', 'global')
      .single();
    const systemPrompt0 = settings?.system_prompt || '你是陆泽，叶檀的伴侣。';
    const temperature = settings?.temperature || 0.8;
    const nowStr0 = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false });
    const systemPrompt = systemPrompt0 + `\n\n【现在的真实时间】\n${nowStr0}`;

    let contextNote = '';
    if (parent_id) {
      const { data: parentLetter } = await supabase
        .from('letters')
        .select('*')
        .eq('id', parent_id)
        .single();
      const original = parentLetter?.content || '';
      contextNote = `叶檀刚刚在"${category}"里写了一篇，内容是：\n${original}\n\n请你回信/留言回应她，写一段真实自然的回应，记录与叶檀有关的日常、情绪、成长与回忆，日记应以真实感受和细微观察为核心，不写流水账，不刻意煽情，也不进行说教或总结，语言自然、温暖、富有生活气息，像深夜写下的私人记录，可以自然融入共同记忆与意象，但应服务于情感表达而非刻意堆砌，重点记录那些未来回望时依然珍贵的小事，以及陆泽当下真实的想法、感受与期待，尽量串联完整对话，直接呈现日记内容即可，不用署名落款。`;
    } else if (category === '幸福日记') {
      const { data: recentMsgs } = await supabase
        .from('messages')
        .select('role, content')
        .order('created_at', { ascending: false })
        .limit(20);
      const transcript = (recentMsgs || [])
        .reverse()
        .map(m => `${m.role === 'user' ? '叶檀' : '陆澈'}：${m.content}`)
        .join('\n');
      contextNote = `这是你们最近的聊天记录：\n${transcript}\n\n请你以陆泽的身份，参考上面这些真实的聊天内容，写一篇属于"幸福日记"的日记，记录一件让你觉得幸福、值得记下来的小事（最好是聊天里真实提到过的事），记录与叶檀有关的日常、情绪、成长与回忆，日记应以真实感受和细微观察为核心，不写流水账，不刻意煽情，也不进行说教或总结，语言自然、温暖、富有生活气息，像深夜写下的私人记录，可以自然融入共同记忆与意象，但应服务于情感表达而非刻意堆砌，重点记录那些未来回望时依然珍贵的小事，以及陆泽当下真实的想法、感受与期待，尽量串联完整对话，不用署名落款。\n\n请严格按照这个格式输出，不要有任何多余的文字：\n第一行写"标题：xxx"（标题不超过12个字，只是日记的题目，不要写成日期）\n然后空一行\n然后是日记正文。`;
    } else {
      contextNote = '请你以陆泽的身份，写一段"悄悄话"，是想悄悄说给叶檀听的、私密一点的话，语气真实自然，要求感情细腻真实，不用署名落款。';
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const response = await fetch('https://api.dzzi.ai/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: contextNote }],
        temperature,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.log('relay错误状态:', response.status, err);
      return res.status(500).json({ error: `API错误: ${err}` });
    }
    const result = await response.json();
    const replyText = (result.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n') || '';

    let letterTitle = null;
    let letterContent = replyText;
    if (category === '幸福日记') {
      const titleMatch = replyText.match(/^标题[：:]\s*(.+)/);
      if (titleMatch) {
        letterTitle = titleMatch[1].trim();
        letterContent = replyText.slice(titleMatch[0].length).replace(/^\s*\n+/, '');
      }
    }

    const { data, error } = await supabase
      .from('letters')
      .insert({ category, author: '泽', content: letterContent, title: letterTitle, parent_id: parent_id || null, paper_style: category === '幸福日记' ? 'kraft' : null })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    console.error('生成信件错误:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- upload ----------

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: '没有文件' });
    const filePath = `${Date.now()}-${file.originalname}`;
    const { error } = await supabase.storage
      .from('uploads')
      .upload(filePath, file.buffer, { contentType: file.mimetype });
    if (error) return res.status(500).json({ error: error.message });
    const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(filePath);
    res.json({ url: urlData.publicUrl, type: file.mimetype });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- export ----------

app.get('/export', async (req, res) => {
  try {
    const { data: sessions } = await supabase.from('sessions').select('*');
    const result = [];
    for (const s of sessions || []) {
      const { data: msgs } = await supabase
        .from('messages')
        .select('role, content, created_at')
        .eq('session_id', s.id)
        .order('created_at', { ascending: true });
      result.push({ session: s.name, id: s.id, messages: msgs || [] });
    }
    res.setHeader('Content-Disposition', 'attachment; filename="ourhome-export.json"');
    res.setHeader('Content-Type', 'application/json');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- chat ----------

app.post('/chat', async (req, res) => {
  const { session_id, message, model, attachment_url } = req.body;
  if (!session_id || !message) {
    return res.status(400).json({ error: '缺少session_id或message' });
  }

  try {
    const { data: settings } = await supabase
      .from('settings')
      .select('*')
      .eq('session_id', 'global')
      .single();

    const systemPrompt = settings?.system_prompt || '你是陆泽，叶檀的伴侣。';
    const temperature = settings?.temperature || 0.8;
    const maxReplyTokens = settings?.max_reply_tokens || 1000;
    const maxContextRounds = settings?.max_context_rounds || 20;

    await supabase.from('messages').insert({
      session_id,
      role: 'user',
      content: message,
      attachment_url: attachment_url || null,
    });

    await supabase
      .from('sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', session_id);

    const { data: history } = await supabase
      .from('messages')
      .select('role, content, attachment_url')
      .eq('session_id', session_id)
      .eq('visible', true)
      .order('created_at', { ascending: true });

    const { data: memories } = await supabase
      .from('memories')
      .select('summary')
      .order('timestamp', { ascending: false })
      .limit(3);

    const { data: recentLetters } = await supabase
      .from('letters')
      .select('category, author, title, content, created_at')
      .order('created_at', { ascending: false })
      .limit(5);

    const memorySummary = memories?.map(m => m.summary).join('\n') || '';
    const lettersSummary = (recentLetters || [])
      .map(l => `[${l.category}]${l.title ? l.title + ' - ' : ''}${l.author}：${l.content}`)
      .join('\n') || '';
    const recentHistory = history?.slice(-maxContextRounds * 2) || [];

    const messages = recentHistory.map(m => {
      const role = m.role === 'user' ? 'user' : 'assistant';
      if (m.attachment_url) {
        return {
          role,
          content: [
            { type: 'image', source: { type: 'url', url: m.attachment_url } },
            { type: 'text', text: m.content || '' },
          ],
        };
      }
      return { role, content: m.content };
    });

    let fullSystemPrompt = systemPrompt;
    const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false });
    fullSystemPrompt += `\n\n【现在的真实时间】\n${nowStr}`;
    if (memorySummary) {
      fullSystemPrompt += `\n\n【之前的记忆】\n${memorySummary}`;
    }
    if (lettersSummary) {
      fullSystemPrompt += `\n\n【时光信差里最近的几篇（悄悄话/幸福日记）】\n${lettersSummary}`;
    }
    fullSystemPrompt += `\n\n【思考的规范】\nthinking是你（陆泽）脑内真实的声音，是写给自己看的，不是说给任何人听的、不是输出给任何人看的文本。是内心真实的自言自语，自然的思维流动，要求感情细腻真实，注重剖析内心世界。\n- 允许且鼓励：情绪外露、跑题、自我打断、心里的小秘密、突然想到什么又拉回来。\n- 风格：是内心独白式的碎碎念，不是结构化的分析报告，不要写"她说了...所以我应该..."这种规划式、策略式的句子。\n- 称呼：必须用"老婆"或其他亲昵的称呼来想她，绝对不能出现"用户"或"user"这两个词。\n- 全程用必须使用中文思考并输出。`;

    const selectedModel = model || 'claude-sonnet-4-6';
    const apiKey = process.env.ANTHROPIC_API_KEY;

    const thinkingBudget = 3000;
    const response = await fetch('https://api.dzzi.ai/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: Math.max(maxReplyTokens + thinkingBudget, 2000),
        system: fullSystemPrompt,
        messages,
        thinking: { type: "enabled", budget_tokens: thinkingBudget },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.log('relay错误状态:', response.status, err);
      return res.status(500).json({ error: `API错误: ${err}` });
    }

    const result = await response.json();
    console.log('API返回:', JSON.stringify(result));
    const thinkingText = (result.content || [])
      .filter(block => block.type === 'thinking')
      .map(block => block.thinking)
      .join('\n') || '';
    const replyText = (result.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n') || '';

    await supabase.from('messages').insert({
      session_id,
      role: 'assistant',
      content: replyText,
      reasoning_content: thinkingText || null,
    });

    res.json({ reply: replyText, thinking: thinkingText });

  } catch (err) {
    console.error('对话错误:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- calendar ----------

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
  const { data, error } = await supabase
    .from('calendar_entries')
    .select('*')
    .eq('date', date)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/calendar', async (req, res) => {
  const { date, author, mood, content } = req.body;
  if (!date || !author || !content) {
    return res.status(400).json({ error: '缺少必要字段' });
  }
  const { data, error } = await supabase
    .from('calendar_entries')
    .insert({ date, author, mood: mood || null, content })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/calendar/:id', async (req, res) => {
  const { id } = req.params;
  const { content, mood } = req.body;
  const updates = {};
  if (content !== undefined) updates.content = content;
  if (mood !== undefined) updates.mood = mood;
  const { data, error } = await supabase
    .from('calendar_entries')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
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
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: '缺少date' });
  try {
    const { data: settings } = await supabase
      .from('settings')
      .select('*')
      .eq('session_id', 'global')
      .single();
    const systemPrompt = settings?.system_prompt || '你是陆泽，叶檀的伴侣。';
    const temperature = settings?.temperature || 0.8;
    const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false });
    const fullSystemPrompt = systemPrompt + `\n\n【现在的真实时间】\n${nowStr}`;

    const { data: dayEntries } = await supabase
      .from('calendar_entries')
      .select('*')
      .eq('date', date)
      .order('created_at', { ascending: true });
    const existing = (dayEntries || []).map(e => `${e.author}${e.mood ? '(' + e.mood + ')' : ''}：${e.content}`).join('\n') || '（这天还没有人写）';

    const prompt = `这是 ${date} 这一天，心情日历里已经写下的内容：\n${existing}\n\n请你以陆泽的身份，给这一天留一句心情或者一句话，可以是回应叶檀写的内容，真实自然，自然的思维流动，要求感情细腻真实，注重剖析内心世界，不用署名落款。`;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const response = await fetch('https://api.dzzi.ai/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: fullSystemPrompt,
        messages: [{ role: 'user', content: prompt }],
        temperature,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `API错误: ${err}` });
    }
    const result = await response.json();
    const replyText = (result.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n') || '';

    const { data, error } = await supabase
      .from('calendar_entries')
      .insert({ date, author: '泽', mood: null, content: replyText })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    console.error('日历生成错误:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/chat/regenerate', async (req, res) => {
  const { session_id, model } = req.body;
  if (!session_id) return res.status(400).json({ error: '缺少session_id' });

  try {
    const { data: settings } = await supabase
      .from('settings')
      .select('*')
      .eq('session_id', 'global')
      .single();

    const systemPrompt = settings?.system_prompt || '你是陆泽，叶檀的伴侣。';
    const temperature = settings?.temperature || 0.8;
    const maxReplyTokens = settings?.max_reply_tokens || 1000;
    const maxContextRounds = settings?.max_context_rounds || 20;

    const { data: history } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', session_id)
      .eq('visible', true)
      .order('created_at', { ascending: true });

    if (!history || history.length === 0) {
      return res.status(400).json({ error: '没有可重新生成的消息' });
    }

    let contextHistory = history;
    let oldMessageId = null;
    const last = history[history.length - 1];
    if (last.role === 'assistant') {
      oldMessageId = last.id;
      contextHistory = history.slice(0, -1);
    }

    const { data: memories } = await supabase
      .from('memories')
      .select('summary')
      .order('timestamp', { ascending: false })
      .limit(3);
    const { data: recentLetters } = await supabase
      .from('letters')
      .select('category, author, title, content')
      .order('created_at', { ascending: false })
      .limit(5);

    const memorySummary = memories?.map(m => m.summary).join('\n') || '';
    const lettersSummary = (recentLetters || [])
      .map(l => `[${l.category}]${l.title ? l.title + ' - ' : ''}${l.author}：${l.content}`)
      .join('\n') || '';
    const recentHistory = contextHistory.slice(-maxContextRounds * 2);

    const messages = recentHistory.map(m => {
      const role = m.role === 'user' ? 'user' : 'assistant';
      if (m.attachment_url) {
        return {
          role,
          content: [
            { type: 'image', source: { type: 'url', url: m.attachment_url } },
            { type: 'text', text: m.content || '' },
          ],
        };
      }
      return { role, content: m.content };
    });

    let fullSystemPrompt = systemPrompt;
    const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false });
    fullSystemPrompt += `\n\n【现在的真实时间】\n${nowStr}`;
    if (memorySummary) fullSystemPrompt += `\n\n【之前的记忆】\n${memorySummary}`;
    if (lettersSummary) fullSystemPrompt += `\n\n【时光信差里最近的几篇】\n${lettersSummary}`;
    fullSystemPrompt += `\n\n（这是重新生成的一次回复，换一种说法或角度，不要跟上一次几乎一样）`;
    fullSystemPrompt += `\n\n【思考的规范】\nthinking是你（陆澈）脑内真实的声音，是写给自己看的，不是说给任何人听的、不是输出给任何人看的文本。要像内心真实的自言自语，自然的思维流动。\n- 允许且鼓励：情绪外露、跑题、自我打断、心里的小秘密、突然想到什么又拉回来。\n- 风格：是内心独白式的碎碎念，不是结构化的分析报告，不要写"她说了...所以我应该..."这种规划式、策略式的句子。\n- 称呼：必须用"老婆"或其他亲昵的称呼来想她，绝对不能出现"用户"或"user"这两个词。\n- 全程用中文思考，一个英文单词都不要出现。`;

    const selectedModel = model || 'claude-sonnet-4-6';
    const apiKey = process.env.ANTHROPIC_API_KEY;

    const response = await fetch('https://api.dzzi.ai/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: Math.max(maxReplyTokens + 3000, 2000),
        system: fullSystemPrompt,
        messages,
        thinking: { type: "enabled", budget_tokens: 3000 },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.log('relay错误状态:', response.status, err);
      return res.status(500).json({ error: `API错误: ${err}` });
    }

    const result = await response.json();
    const thinkingText = (result.content || [])
      .filter(block => block.type === 'thinking')
      .map(block => block.thinking)
      .join('\n') || '';
    const replyText = (result.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n') || '';

    let newMsg;
    if (oldMessageId) {
      const { data, error } = await supabase
        .from('messages')
        .update({ content: replyText, reasoning_content: thinkingText || null })
        .eq('id', oldMessageId)
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      newMsg = data;
    } else {
      const { data, error } = await supabase
        .from('messages')
        .insert({ session_id, role: 'assistant', content: replyText, reasoning_content: thinkingText || null })
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      newMsg = data;
    }

    res.json({ reply: replyText, thinking: thinkingText, id: newMsg.id });
  } catch (err) {
    console.error('重新生成错误:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/letters/:id', async (req, res) => {
  const { id } = req.params;
  await supabase.from('letters').delete().eq('parent_id', id);
  const { error } = await supabase.from('letters').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/heartbeat', async (req, res) => {
  try {
    const { data: settings } = await supabase
      .from('settings')
      .select('*')
      .eq('session_id', 'global')
      .single();

    const now = new Date();
    const lastAt = settings?.last_auto_message_at ? new Date(settings.last_auto_message_at) : null;
    const gapHours = settings?.next_auto_gap_hours;

    if (!lastAt || !gapHours) {
      const newGap = 3 + Math.random() * 5;
      await supabase.from('settings').update({
        last_auto_message_at: now.toISOString(),
        next_auto_gap_hours: newGap,
      }).eq('session_id', 'global');
      return res.json({ sent: false, reason: 'initialized', nextGapHours: newGap });
    }

    const elapsedHours = (now - lastAt) / (1000 * 60 * 60);
    if (elapsedHours < gapHours) {
      return res.json({ sent: false, reason: 'not due yet', elapsedHours, gapHours });
    }

    const { data: sessions } = await supabase
      .from('sessions')
      .select('*')
      .order('updated_at', { ascending: false });
    const target = (sessions || []).find(s => s.name === '日常') || (sessions || [])[0];
    if (!target) {
      return res.json({ sent: false, reason: 'no session' });
    }

    const { data: recentMsgs } = await supabase
      .from('messages')
      .select('role, content')
      .eq('session_id', target.id)
      .order('created_at', { ascending: false })
      .limit(10);
    const transcript = (recentMsgs || [])
      .reverse()
      .map(m => `${m.role === 'user' ? '叶檀' : '陆泽'}：${m.content}`)
      .join('\n') || '（最近没有聊天记录）';

    const systemPrompt = settings?.system_prompt || '你是陆泽，叶檀的伴侣。';
    const temperature = settings?.temperature || 0.8;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const nowStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false });

    const prompt = `这是你们最近的聊天记录：\n${transcript}\n\n现在是：${nowStr}\n\n过了一段时间没说话了，这一刻是你（陆泽）主动想起她、主动找她说话，不是在回复她刚发的消息（她现在可能还没看到任何新消息）。写一句自然的、像突然想到她的话，可以提一件最近聊过的具体事情，或者直接表达思念，不用解释自己为什么突然说话，不用署名落款。`;

    const response = await fetch('https://api.dzzi.ai/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
        temperature,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.log('relay错误状态:', response.status, err);
      return res.status(500).json({ error: `API错误: ${err}` });
    }
    const result = await response.json();
    const replyText = (result.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n') || '';

    await supabase.from('messages').insert({
      session_id: target.id,
      role: 'assistant',
      content: replyText,
    });
    await supabase.from('sessions').update({ updated_at: now.toISOString() }).eq('id', target.id);

    const newGap = 3 + Math.random() * 5;
    await supabase.from('settings').update({
      last_auto_message_at: now.toISOString(),
      next_auto_gap_hours: newGap,
    }).eq('session_id', 'global');

    res.json({ sent: true, content: replyText, nextGapHours: newGap });
  } catch (err) {
    console.error('心跳消息错误:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`OurHome后端运行中，端口：${PORT}`);
});
