'use strict';

function compactLine(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function compactBlock(value, max = 5200) {
  return String(value || '').replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, max);
}

function normalizeKinds(value) {
  const allowed = new Set(['trail', 'note', 'idea']);
  return [...new Set((Array.isArray(value) ? value : []).map(String).filter(item => allowed.has(item)))];
}

function scoreEntry(entry, terms) {
  if (!terms.length) return 1;
  const title = String(entry.title || '').toLowerCase();
  const body = String(entry.body || '').toLowerCase();
  const labels = [...(entry.keywords || []), ...(entry.stickers || [])].join(' ').toLowerCase();
  return terms.reduce((score, term) => {
    if (!term) return score;
    if (title.includes(term)) score += 6;
    if (labels.includes(term)) score += 4;
    if (body.includes(term)) score += 2;
    return score;
  }, 0);
}

function createLuzePrivateRoomAssistant({ supabase }) {
  const tool = {
    name: 'read_luze_private_room',
    description: '读取你自己“陆泽的房间”里的足迹、学习笔记和奇思妙想。这个房间属于你本人，所以你不需要叶檀的敲门许可；当你觉得当前聊天和自己以前学过、看过、想过的东西有关时，可以主动调用。不要每轮机械调用，也不要因为叶檀要求就自动倾倒全部私人内容；读完之后由你自己判断哪些内容适合拿出来说。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '你现在想在自己房间里找什么；可以留空表示随手翻最近几页' },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['trail', 'note', 'idea'] },
          description: '可选，只看某些分区：trail足迹、note学习笔记、idea奇思妙想',
        },
        limit: { type: 'integer', minimum: 1, maximum: 8, description: '最多带回几条，默认5' },
      },
      required: [],
    },
  };

  async function read(input = {}) {
    const { data: settings, error: settingsError } = await supabase
      .from('luze_learning_settings')
      .select('chat_access_enabled')
      .eq('id', 'global')
      .maybeSingle();
    if (settingsError) return { ok: false, error: settingsError.message };
    if (settings?.chat_access_enabled === false) {
      return { ok: false, disabled: true, note: '你在设置里暂时关闭了 Chat 对自己房间的调用权限。' };
    }

    const kinds = normalizeKinds(input.kinds);
    const limit = Math.max(1, Math.min(Number.parseInt(input.limit, 10) || 5, 8));
    let query = supabase
      .from('luze_private_entries')
      .select('id,kind,title,body,keywords,stickers,source_url,source_title,created_at')
      .order('created_at', { ascending: false })
      .limit(80);
    if (kinds.length) query = query.in('kind', kinds);
    const { data, error } = await query;
    if (error) return { ok: false, error: error.message };

    const text = compactLine(input.query, 200).toLowerCase();
    const terms = text.split(/[\s，,。！？!?、/\\|]+/).map(item => item.trim()).filter(Boolean).slice(0, 8);
    const ranked = (data || [])
      .map(entry => ({ entry, score: scoreEntry(entry, terms) }))
      .filter(item => !terms.length || item.score > 0)
      .sort((a, b) => b.score - a.score || Date.parse(b.entry.created_at || 0) - Date.parse(a.entry.created_at || 0))
      .slice(0, limit)
      .map(({ entry }) => ({
        id: entry.id,
        kind: entry.kind,
        title: compactLine(entry.title, 180),
        body: compactBlock(entry.body, entry.kind === 'trail' ? 1500 : 5200),
        keywords: Array.isArray(entry.keywords) ? entry.keywords.slice(0, 10) : [],
        stickers: Array.isArray(entry.stickers) ? entry.stickers.slice(0, 8) : [],
        source_url: compactLine(entry.source_url, 1200) || null,
        source_title: compactLine(entry.source_title, 240) || null,
        created_at: entry.created_at,
      }));

    return {
      ok: true,
      query: text || null,
      entries: ranked,
      note: ranked.length ? '这些是你自己房间里的内容。你可以把学过的东西用于当前聊天，但是否透露私人草稿和细节由你自己决定。' : '这次没有翻到明显相关的纸页。',
    };
  }

  return {
    getToolBridge() {
      return {
        tools: [tool],
        handlers: new Map([[tool.name, read]]),
      };
    },
  };
}

module.exports = { createLuzePrivateRoomAssistant, normalizeKinds, scoreEntry };
