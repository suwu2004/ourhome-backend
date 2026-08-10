from pathlib import Path

path = Path('server.js')
text = path.read_text()
old_import = "const { parseChatHistoryPaging, finalizeChatHistoryPage } = require('./chatHistoryPaging');"
new_import = "const { parseChatHistoryPaging, chatHistoryFetchLimit, finalizeChatHistoryPage } = require('./chatHistoryPaging');"
if old_import not in text:
    raise SystemExit('paging import anchor missing')
text = text.replace(old_import, new_import, 1)
old = """  let query = supabase.from('messages').select('*')
    .eq('session_id', id)
    .eq('visible', true)
    .order('created_at', { ascending: false })
    .limit(paging.limit + 1);
  if (paging.before) query = query.lt('created_at', paging.before);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.json(finalizeChatHistoryPage(data, paging.limit));
"""
new = """  let query = supabase.from('messages').select('*')
    .eq('session_id', id)
    .eq('visible', true)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(chatHistoryFetchLimit(paging));
  if (paging.before) query = query.lte('created_at', paging.before.createdAt);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.json(finalizeChatHistoryPage(data, paging));
"""
if old not in text:
    raise SystemExit('paged route anchor missing')
text = text.replace(old, new, 1)
path.write_text(text)
