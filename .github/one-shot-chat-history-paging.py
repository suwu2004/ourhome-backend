from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)

path = Path('server.js')
text = path.read_text()
if "./chatHistoryPaging" not in text:
    text = replace_once(
        text,
        "const { registerReadingRoutes } = require('./readingStore');\n",
        "const { registerReadingRoutes } = require('./readingStore');\nconst { parseChatHistoryPaging, finalizeChatHistoryPage } = require('./chatHistoryPaging');\n",
        'chat paging import',
    )
old = """app.get('/sessions/:id/messages', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase.from('messages').select('*')
    .eq('session_id', id).eq('visible', true).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
"""
new = """app.get('/sessions/:id/messages', async (req, res) => {
  const { id } = req.params;
  const paging = parseChatHistoryPaging(req.query);
  if (!paging) {
    const { data, error } = await supabase.from('messages').select('*')
      .eq('session_id', id).eq('visible', true).order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  }

  let query = supabase.from('messages').select('*')
    .eq('session_id', id)
    .eq('visible', true)
    .order('created_at', { ascending: false })
    .limit(paging.limit + 1);
  if (paging.before) query = query.lt('created_at', paging.before);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.json(finalizeChatHistoryPage(data, paging.limit));
});
"""
text = replace_once(text, old, new, 'messages endpoint')
path.write_text(text)
