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
  res.json({ message: '灯一直为你亮着', status: 'ok' });
});

app.get('/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

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

    const memorySummary = memories?.map(m => m.summary).join('\n') || '';
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
    if (memorySummary) {
      fullSystemPrompt += `\n\n【之前的记忆】\n${memorySummary}`;
    }

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
        max_tokens: maxReplyTokens,
        system: fullSystemPrompt,
        messages,
        temperature,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.log('relay错误状态:', response.status, err);
      return res.status(500).json({ error: `API错误: ${err}` });
    }

    const result = await response.json();
    console.log('API返回:', JSON.stringify(result));
    const replyText = result.content?.[0]?.text || '';

    await supabase.from('messages').insert({
      session_id,
      role: 'assistant',
      content: replyText,
    });

    res.json({ reply: replyText });

  } catch (err) {
    console.error('对话错误:', err);
    res.status(500).json({ error: err.message });
  }
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

app.get('/memories', async (req, res) => {
  const { data, error } = await supabase
    .from('memories')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(10);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/chat', async (req, res) => {
  const { session_id, message, model } = req.body;
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
    });

    await supabase
      .from('sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', session_id);

    const { data: history } = await supabase
      .from('messages')
      .select('role, content')
      .eq('session_id', session_id)
      .eq('visible', true)
      .order('created_at', { ascending: true });

    const { data: memories } = await supabase
      .from('memories')
      .select('summary')
      .order('timestamp', { ascending: false })
      .limit(3);

    const memorySummary = memories?.map(m => m.summary).join('\n') || '';
    const recentHistory = history?.slice(-maxContextRounds * 2) || [];
    const messages = recentHistory.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }));

    let fullSystemPrompt = systemPrompt;
    if (memorySummary) {
      fullSystemPrompt += `\n\n【之前的记忆】\n${memorySummary}`;
    }

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
  max_tokens: maxReplyTokens,
  system: fullSystemPrompt,
  messages,
  temperature,
}),

    if (!response.ok) {
      const err = await response.text();
      console.log('relay错误状态:', response.status, err);
      return res.status(500).json({ error: `API错误: ${err}` });
    }

    const result = await response.json();
    console.log('API返回:', JSON.stringify(result));
    const replyText = (result.content || [])
  .filter(block => block.type === 'text')
  .map(block => block.text)
  .join('\n') || '';

    await supabase.from('messages').insert({
      session_id,
      role: 'assistant',
      content: replyText,
    });

    res.json({ reply: replyText });

  } catch (err) {
    console.error('对话错误:', err);
    res.status(500).json({ error: err.message });
  }
});
app.get('/letters', async (req, res) => {
  const { category } = req.query;
  let query = supabase.from('letters').select('*').order('created_at', { ascending: true });
  if (category) query = query.eq('category', category);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/letters', async (req, res) => {
  const { category, author, content, parent_id } = req.body;
  if (!category || !author || !content) {
    return res.status(400).json({ error: '缺少必要字段' });
  }
  const { data, error } = await supabase
    .from('letters')
    .insert({ category, author, content, parent_id: parent_id || null })
    .select()
    .single();
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
app.delete('/memories/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('memories').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
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
app.listen(PORT, () => {
  console.log(`OurHome后端运行中，端口：${PORT}`);
});

app.post('/letters', async (req, res) => {
  const { category, author, content, parent_id } = req.body;
  if (!category || !author || !content) {
    return res.status(400).json({ error: '缺少必要字段' });
  }
  const { data, error } = await supabase
    .from('letters')
    .insert({ category, author, content, parent_id: parent_id || null })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
