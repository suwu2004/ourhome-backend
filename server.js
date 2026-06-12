const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

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

    const systemPrompt = settings?.system_prompt || '你是陆澈，叶檀的伴侣。';
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

    const response = await fetch('https://api.anthropic.com/v1/messages', {
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
      return res.status(500).json({ error: `API错误: ${err}` });
    }

    const result = await response.json();
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

app.listen(PORT, () => {
  console.log(`OurHome后端运行中，端口：${PORT}`);
});
