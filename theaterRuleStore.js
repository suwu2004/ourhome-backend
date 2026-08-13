const MAX_RULES = 100;
const MAX_RULE_TITLE_CHARS = 80;
const MAX_RULE_CONTENT_CHARS = 20_000;
const MAX_COMPILED_RULE_CHARS = 20_000;
const LEGACY_RULE_CATEGORY = '小剧场通用规则';
const RULE_SCOPES = ['theater', 'chat', 'both'];

function cleanRuleText(value, max) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, max);
}

function cleanRuleTitle(value, fallback = '未命名规则') {
  return cleanRuleText(value, MAX_RULE_TITLE_CHARS).replace(/\n+/g, ' ') || fallback;
}

function normalizeRuleScope(value, fallback = 'theater') {
  const scope = String(value || '').trim().toLowerCase();
  return RULE_SCOPES.includes(scope) ? scope : fallback;
}

function ruleAppliesToScope(rule, scope = 'theater') {
  const target = normalizeRuleScope(scope);
  const ruleScope = normalizeRuleScope(rule?.apply_scope);
  return ruleScope === 'both' || ruleScope === target;
}

function normalizeRuleInput(value = {}, { partial = false } = {}) {
  const normalized = {};

  if (!partial || Object.prototype.hasOwnProperty.call(value, 'title')) {
    normalized.title = cleanRuleTitle(value.title);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(value, 'content')) {
    normalized.content = cleanRuleText(value.content, MAX_RULE_CONTENT_CHARS);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(value, 'enabled')) {
    normalized.enabled = value.enabled !== false;
  }
  if (!partial || Object.prototype.hasOwnProperty.call(value, 'apply_scope')) {
    normalized.apply_scope = normalizeRuleScope(value.apply_scope);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(value, 'source_name')) {
    normalized.source_name = cleanRuleText(value.source_name, 240).replace(/\n+/g, ' ') || null;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'sort_order')) {
    const order = Number(value.sort_order);
    normalized.sort_order = Number.isFinite(order)
      ? Math.max(-100_000, Math.min(100_000, Math.round(order)))
      : 0;
  }

  return normalized;
}

function parseLegacyRulesContent(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return cleanRuleText(parsed?.rules || raw, MAX_RULE_CONTENT_CHARS);
  } catch {
    return cleanRuleText(raw, MAX_RULE_CONTENT_CHARS);
  }
}

function compileTheaterRules(rules = [], scope = 'theater') {
  const sections = (Array.isArray(rules) ? rules : [])
    .filter(rule => rule?.enabled !== false && ruleAppliesToScope(rule, scope) && String(rule?.content || '').trim())
    .sort((a, b) => {
      const order = (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
      if (order) return order;
      return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    })
    .map(rule => `【${cleanRuleTitle(rule.title)}】\n${cleanRuleText(rule.content, MAX_RULE_CONTENT_CHARS)}`);

  return cleanRuleText(sections.join('\n\n'), MAX_COMPILED_RULE_CHARS);
}

function compileChatRules(rules = []) {
  return compileTheaterRules(rules, 'chat');
}

async function loadCompiledRules(supabase, scope = 'theater') {
  const { data, error } = await supabase
    .from('theater_rules')
    .select('title, content, enabled, apply_scope, sort_order, created_at')
    .eq('enabled', true)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(MAX_RULES);
  if (error) {
    // During a rolling deploy, an older database may briefly lack apply_scope.
    // Chat must remain available until the migration reaches that environment.
    if (['42703', 'PGRST204'].includes(error.code)) return '';
    throw error;
  }
  return compileTheaterRules(data || [], scope);
}

function createTheaterRuleStore(supabase) {
  async function listRules() {
    const { data, error } = await supabase
      .from('theater_rules')
      .select('id, title, content, enabled, apply_scope, sort_order, source_name, created_at, updated_at')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(MAX_RULES);
    if (error) throw error;
    return data || [];
  }

  async function ensureLegacyRuleMigrated() {
    const rules = await listRules();
    if (rules.length) return rules;

    const { data: legacy, error: legacyError } = await supabase
      .from('letters')
      .select('content, created_at')
      .eq('category', LEGACY_RULE_CATEGORY)
      .is('parent_id', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (legacyError) throw legacyError;

    const content = parseLegacyRulesContent(legacy?.content);
    if (!content) return [];
    const firstLine = content.split('\n').map(line => line.trim()).find(Boolean) || '';
    const { data, error } = await supabase
      .from('theater_rules')
      .insert({
        title: cleanRuleTitle(firstLine, '原有通用规则'),
        content,
        enabled: true,
        apply_scope: 'theater',
        sort_order: 0,
        source_name: '从原通用规则迁移',
      })
      .select()
      .single();
    if (error) throw error;
    return [data];
  }

  async function syncLegacyRules(providedRules = null) {
    const rules = providedRules || await listRules();
    const compiled = compileTheaterRules(rules);
    const payload = {
      category: LEGACY_RULE_CATEGORY,
      author: '檀',
      title: '小剧场通用规则',
      content: JSON.stringify({ rules: compiled }),
      parent_id: null,
      paper_style: null,
    };

    const { data: existing, error: existingError } = await supabase
      .from('letters')
      .select('id')
      .eq('category', LEGACY_RULE_CATEGORY)
      .is('parent_id', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingError) throw existingError;

    if (existing?.id) {
      const { error } = await supabase.from('letters').update(payload).eq('id', existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('letters').insert(payload);
      if (error) throw error;
    }
    return compiled;
  }

  async function createRule(rawValue = {}) {
    const value = normalizeRuleInput(rawValue);
    if (!value.content) throw new Error('规则正文不能为空。');

    const existing = await listRules();
    if (existing.length >= MAX_RULES) throw new Error(`通用规则最多保存 ${MAX_RULES} 条。`);
    const maxOrder = existing.reduce((max, rule) => Math.max(max, Number(rule.sort_order) || 0), -10);
    if (!Object.prototype.hasOwnProperty.call(rawValue, 'sort_order')) value.sort_order = maxOrder + 10;

    const { data, error } = await supabase.from('theater_rules').insert(value).select().single();
    if (error) throw error;
    await syncLegacyRules([...existing, data]);
    return data;
  }

  async function updateRule(ruleId, rawValue = {}) {
    const patch = normalizeRuleInput(rawValue, { partial: true });
    if (Object.prototype.hasOwnProperty.call(patch, 'content') && !patch.content) {
      throw new Error('规则正文不能为空。');
    }
    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('theater_rules')
      .update(patch)
      .eq('id', ruleId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    await syncLegacyRules();
    return data;
  }

  async function deleteRule(ruleId) {
    const { data, error } = await supabase
      .from('theater_rules')
      .delete()
      .eq('id', ruleId)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return false;
    await syncLegacyRules();
    return true;
  }

  async function reorderRules(ids = []) {
    const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map(id => String(id || '').trim()).filter(Boolean))]
      .slice(0, MAX_RULES);
    for (let index = 0; index < uniqueIds.length; index += 1) {
      const { error } = await supabase
        .from('theater_rules')
        .update({ sort_order: index * 10, updated_at: new Date().toISOString() })
        .eq('id', uniqueIds[index]);
      if (error) throw error;
    }
    const rules = await listRules();
    await syncLegacyRules(rules);
    return rules;
  }

  return {
    listRules,
    ensureLegacyRuleMigrated,
    syncLegacyRules,
    createRule,
    updateRule,
    deleteRule,
    reorderRules,
  };
}

function registerTheaterRuleRoutes(app, { supabase }) {
  const store = createTheaterRuleStore(supabase);

  app.get('/theater/rules', async (_req, res) => {
    try {
      const rules = await store.ensureLegacyRuleMigrated();
      res.json(rules);
    } catch (error) {
      res.status(500).json({ error: error.message || '通用规则库暂时没有打开' });
    }
  });

  app.post('/theater/rules', async (req, res) => {
    try {
      res.json(await store.createRule(req.body || {}));
    } catch (error) {
      res.status(400).json({ error: error.message || '这条规则没有保存成功' });
    }
  });

  app.patch('/theater/rules/:id', async (req, res) => {
    try {
      const rule = await store.updateRule(req.params.id, req.body || {});
      if (!rule) return res.status(404).json({ error: '找不到这条规则' });
      res.json(rule);
    } catch (error) {
      res.status(400).json({ error: error.message || '这条规则没有修改成功' });
    }
  });

  app.delete('/theater/rules/:id', async (req, res) => {
    try {
      const deleted = await store.deleteRule(req.params.id);
      if (!deleted) return res.status(404).json({ error: '找不到这条规则' });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message || '这条规则没有删除成功' });
    }
  });

  app.put('/theater/rules/order', async (req, res) => {
    try {
      res.json(await store.reorderRules(req.body?.ids || []));
    } catch (error) {
      res.status(400).json({ error: error.message || '规则顺序没有保存成功' });
    }
  });

  return store;
}

module.exports = {
  MAX_RULES,
  MAX_RULE_TITLE_CHARS,
  MAX_RULE_CONTENT_CHARS,
  MAX_COMPILED_RULE_CHARS,
  cleanRuleText,
  cleanRuleTitle,
  RULE_SCOPES,
  normalizeRuleScope,
  ruleAppliesToScope,
  normalizeRuleInput,
  parseLegacyRulesContent,
  compileTheaterRules,
  compileChatRules,
  loadCompiledRules,
  createTheaterRuleStore,
  registerTheaterRuleRoutes,
};
