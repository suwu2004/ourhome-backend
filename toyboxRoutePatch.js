'use strict';

const { createClient } = require('@supabase/supabase-js');

const express = require('express');
const originalListen = express.application.listen;
let registered = false;
let supabaseClient = null;

function getSupabase() {
  if (supabaseClient) return supabaseClient;
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_KEY || '').trim();
  if (!url || !key) throw new Error('Toybox Supabase 尚未配置');
  supabaseClient = createClient(url, key);
  return supabaseClient;
}

function compactLine(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function compactBlock(value, max = 12_000) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, max);
}

function safeList(value, limit = 16, itemMax = 120) {
  return (Array.isArray(value) ? value : [])
    .map(item => compactLine(item, itemMax))
    .filter(Boolean)
    .slice(0, limit);
}

function clampInt(value, min, max, fallback = min) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function buildEndpoint(base, path) {
  const clean = String(base || '').replace(/\/+$/, '');
  return clean.endsWith(path) ? clean : `${clean}${path}`;
}

function parseJsonObject(value) {
  const text = String(value || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch { return null; }
}

function extractModelText(payload = {}) {
  if (typeof payload?.content === 'string') return compactBlock(payload.content, 20_000);
  if (Array.isArray(payload?.content)) {
    const text = payload.content
      .filter(block => !block?.type || ['text', 'output_text'].includes(block.type))
      .map(block => String(block?.text ?? block?.content ?? ''))
      .filter(Boolean)
      .join('\n');
    if (text) return compactBlock(text, 20_000);
  }
  for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
    const text = choice?.message?.content ?? choice?.text;
    if (typeof text === 'string' && text.trim()) return compactBlock(text, 20_000);
  }
  return compactBlock(payload?.text ?? payload?.output_text ?? '', 20_000);
}

function personaOnly(systemPrompt) {
  const raw = String(systemPrompt || '你是陆泽，叶檀的伴侣。');
  const adultGuide = raw.indexOf('【性爱指南】');
  const clipped = adultGuide >= 0 ? raw.slice(0, adultGuide) : raw;
  // Toybox only needs enough persona to sound like Lu Ze. Keeping this compact
  // avoids paying the full Chat persona/context cost for every little game call.
  return compactBlock(clipped, 6_500);
}

async function loadRuntime(preferredModel = '') {
  const supabase = getSupabase();
  const [{ data: settings, error: settingsError }, { data: profile, error: profileError }] = await Promise.all([
    supabase.from('settings').select('*').eq('session_id', 'global').maybeSingle(),
    supabase.from('api_profiles').select('*').eq('is_active', true).maybeSingle(),
  ]);
  if (settingsError) throw settingsError;
  if (profileError && !['42P01', 'PGRST205'].includes(profileError.code)) throw profileError;

  let profileKey = null;
  if (profile?.id) {
    const { data, error } = await supabase.rpc('ourhome_get_api_profile_secret', { p_profile_id: profile.id });
    if (error) throw error;
    profileKey = Array.isArray(data) ? data[0] : data;
  }

  const apiKey = String(profileKey || settings?.api_key || process.env.ANTHROPIC_API_KEY || '').trim();
  const baseUrl = compactLine(profile?.base_url || settings?.api_base_url || process.env.ANTHROPIC_API_BASE_URL || 'https://api.anthropic.com/v1', 1000);
  const requested = compactLine(preferredModel, 240);
  const model = requested || compactLine(profile?.selected_model || settings?.selected_model || 'claude-sonnet-4-6', 240);
  if (!apiKey) throw new Error('当前 API 站点没有可用密钥');
  return { settings: settings || {}, apiKey, baseUrl, model, chatModel: compactLine(profile?.selected_model || settings?.selected_model || '', 240) };
}

async function loadRelationshipContext() {
  try {
    const supabase = getSupabase();
    const [{ data: memories }, { data: daily }] = await Promise.all([
      supabase.from('memories')
        .select('summary,is_protected,timestamp')
        .order('is_protected', { ascending: false })
        .order('timestamp', { ascending: false })
        .limit(10),
      supabase.from('daily_summaries')
        .select('summary,summary_date')
        .order('summary_date', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const memoryLines = (memories || [])
      .map(item => compactLine(item.summary, 150))
      .filter(Boolean)
      .slice(0, 6);
    const parts = [];
    if (memoryLines.length) parts.push(`【可自然参考的少量共同记忆】\n${memoryLines.map(item => `- ${item}`).join('\n')}`);
    if (daily?.summary) parts.push(`【最近气氛】\n${compactLine(daily.summary, 220)}`);
    return parts.join('\n\n');
  } catch (error) {
    console.warn('[toybox] relationship context unavailable:', error.message);
    return '';
  }
}

async function callModel({ runtime, system, messages, maxTokens = 650, temperature = 0.9 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const endpoint = buildEndpoint(runtime.baseUrl, '/messages');
    const thinkingNamed = /thinking|reasoning/i.test(runtime.model);
    const body = {
      model: runtime.model,
      max_tokens: maxTokens,
      temperature: thinkingNamed ? 1 : temperature,
      system,
      messages,
    };
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': runtime.apiKey,
        Authorization: `Bearer ${runtime.apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`小游戏模型暂时没有回应 (${response.status})：${raw.slice(0, 500)}`);
    let payload;
    try { payload = JSON.parse(raw); }
    catch { throw new Error('小游戏模型返回了无法解析的数据'); }
    const text = extractModelText(payload);
    if (!text) throw new Error('小游戏模型没有返回文字');
    return { text, model: payload?.model || runtime.model };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('小游戏模型连接超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function toyboxSystem(runtime, extra) {
  const relationship = await loadRelationshipContext();
  const base = personaOnly(runtime.settings?.system_prompt);
  return [
    base,
    relationship,
    `【玩具箱】\n这是 OurHome 里的轻量互动小游戏，不是正式聊天。保持陆泽本人自然的判断和口吻，但不要写长篇回复、不要解释规则、不要提模型或系统。${extra}`,
  ].filter(Boolean).join('\n\n');
}

function requireObject(data, fields) {
  if (!data || typeof data !== 'object') throw new Error('小游戏这次没有按约定出题');
  for (const field of fields) {
    if (!compactLine(data[field], 500)) throw new Error('小游戏这次出的题不完整');
  }
  return data;
}

function normalizeHarmonyRound(data) {
  requireObject(data, ['question', 'option_a', 'option_b', 'luze_choice']);
  const choice = String(data.luze_choice || '').trim().toUpperCase();
  if (!['A', 'B'].includes(choice)) throw new Error('陆泽这次没把选项锁好');
  return {
    question: compactLine(data.question, 120),
    option_a: compactLine(data.option_a, 80),
    option_b: compactLine(data.option_b, 80),
    luze_choice: choice,
    luze_comment: compactLine(data.luze_comment, 150) || '嗯，答案锁了。现在看我们是不是想到一起。',
  };
}

function normalizeSecretRound(data) {
  requireObject(data, ['answer', 'category', 'hint1', 'hint2']);
  const answer = compactLine(data.answer, 20).replace(/\s+/g, '');
  if (!answer || answer.length > 12) throw new Error('这轮暗号长度不太适合玩');
  return {
    answer,
    category: compactLine(data.category, 30),
    hint1: compactLine(data.hint1, 110),
    hint2: compactLine(data.hint2, 110),
    reveal_comment: compactLine(data.reveal_comment, 150) || '记住它，下次说不定又会碰见。',
  };
}

function normalizeDrawingPrompt(data) {
  requireObject(data, ['prompt']);
  return {
    prompt: compactLine(data.prompt, 50),
    tease: compactLine(data.tease, 120) || '画吧，我等着看你能把它画成什么。',
  };
}

function extractRounds(parsed, count, normalizer) {
  const source = Array.isArray(parsed?.rounds) ? parsed.rounds : (count === 1 ? [parsed] : []);
  const normalized = [];
  for (const item of source) {
    try { normalized.push(normalizer(item)); } catch { /* skip one malformed item */ }
    if (normalized.length >= count) break;
  }
  if (!normalized.length) throw new Error('小游戏这次没有按约定批量出题');
  return normalized;
}

function respondRounds(res, rounds, model, count) {
  if (count === 1) return res.json({ ...rounds[0], model });
  return res.json({ rounds: rounds.map(item => ({ ...item, model })), model });
}

function registerToyboxRoutes(app) {
  if (registered) return;
  registered = true;

  app.get('/toybox/status', async (req, res) => {
    try {
      const runtime = await loadRuntime(req.query?.model);
      res.json({ ok: true, toybox: 'interactive-budget-v2', model: runtime.model, chat_model: runtime.chatModel });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/toybox/harmony-round', async (req, res) => {
    try {
      const count = clampInt(req.body?.count, 1, 12, 1);
      const runtime = await loadRuntime(req.body?.model);
      const recent = safeList(req.body?.recent_questions, 20, 100);
      const system = await toyboxSystem(runtime, '你们正在玩“默契大考验”。陆泽必须在不知道叶檀会选什么的情况下先独立选 A 或 B。若一次生成多题，每一题的答案也都要现在就锁定。');
      const prompt = `一次生成 ${count} 道彼此不同、适合情侣玩的二选一题。题目可以来自生活习惯、奇怪脑洞、旅行、食物、审美、相处方式、假设情境、轻微恶作剧等，不要只围绕共同记忆，也不要总是恋爱鸡汤。\n${recent.length ? `最近已经出过这些，避开重复：\n${recent.map(item => `- ${item}`).join('\n')}\n` : ''}\n每题都先替陆泽自己独立选好 A 或 B；叶檀此刻还没看到这些题，所以不能根据她之后的选择改答案。只输出 JSON：\n{"rounds":[{"question":"12-36字的问题","option_a":"不超过18字","option_b":"不超过18字","luze_choice":"A或B","luze_comment":"揭晓时的一句自然短话，不超过45字"}]}`;
      const result = await callModel({
        runtime,
        system,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: Math.min(2600, 320 + count * 180),
        temperature: 1,
      });
      const rounds = extractRounds(parseJsonObject(result.text), count, normalizeHarmonyRound);
      return respondRounds(res, rounds, result.model, count);
    } catch (error) {
      console.error('[toybox:harmony]', error.message);
      res.status(500).json({ error: error.message || '默契题暂时没出好' });
    }
  });

  app.post('/toybox/secret-round', async (req, res) => {
    try {
      const count = clampInt(req.body?.count, 1, 12, 1);
      const runtime = await loadRuntime(req.body?.model);
      const recent = safeList(req.body?.recent_answers, 24, 40);
      const system = await toyboxSystem(runtime, '你们正在玩“暗号猜猜”。答案由陆泽随机出题；范围要开，不局限于两人的固定梗。一次生成多题时也必须彼此不同。');
      const prompt = `一次随机想 ${count} 个彼此不同、适合中文猜词小游戏的答案。题材要真正扩散：自然、物件、地点、食物、动作、职业、动物、植物、文学、科技、日常、抽象概念、网络词、幻想事物都可以。不要被共同记忆绑死。答案以 2-6 个中文字符为主，偶尔可以是大家熟悉的短词，不要生僻到无法猜。\n${recent.length ? `最近出现过这些答案，本批不要重复或只换同义词：${recent.join('、')}\n` : ''}\n只输出 JSON：\n{"rounds":[{"answer":"答案","category":"宽泛分类，不超过8字","hint1":"含蓄提示，不含答案","hint2":"更明显提示，不含答案","reveal_comment":"揭晓时陆泽的一句短话，不超过45字"}]}`;
      const result = await callModel({
        runtime,
        system,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: Math.min(2500, 320 + count * 165),
        temperature: 1,
      });
      const rounds = extractRounds(parseJsonObject(result.text), count, normalizeSecretRound);
      return respondRounds(res, rounds, result.model, count);
    } catch (error) {
      console.error('[toybox:secret]', error.message);
      res.status(500).json({ error: error.message || '暗号这次没有藏好' });
    }
  });

  app.post('/toybox/drawing-prompt', async (req, res) => {
    try {
      const count = clampInt(req.body?.count, 1, 12, 1);
      const runtime = await loadRuntime(req.body?.model);
      const recent = safeList(req.body?.recent_prompts, 20, 50);
      const system = await toyboxSystem(runtime, '你们正在玩“你画我猜”。陆泽只负责给好画、好猜、偶尔有点离谱的题目。');
      const prompt = `一次随机给 ${count} 个彼此不同、适合手机手绘的题目。优先具体可画的东西或小场景，难度不要太高，但可以偶尔调皮。\n${recent.length ? `避开最近题目：${recent.join('、')}\n` : ''}\n只输出 JSON：{"rounds":[{"prompt":"2-10字题目","tease":"陆泽出题时的一句短话，不超过36字"}]}`;
      const result = await callModel({
        runtime,
        system,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: Math.min(1500, 220 + count * 95),
        temperature: 1,
      });
      const rounds = extractRounds(parseJsonObject(result.text), count, normalizeDrawingPrompt);
      return respondRounds(res, rounds, result.model, count);
    } catch (error) {
      console.error('[toybox:drawing-prompt]', error.message);
      res.status(500).json({ error: error.message || '画题这次没抽出来' });
    }
  });

  app.post('/toybox/guess-drawing', async (req, res) => {
    try {
      const image = String(req.body?.image || '');
      const match = image.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/i);
      if (!match) return res.status(400).json({ error: '画布图片格式不正确' });
      if (match[2].length > 3_600_000) return res.status(400).json({ error: '这张画太大了，先清一点再猜' });

      const runtime = await loadRuntime(req.body?.model);
      const system = await toyboxSystem(runtime, '你们正在玩“你画我猜”。你现在真的能看到叶檀画的图。不要假装看不清就乱编；按图像本身猜。');
      const prompt = '看这张手绘，猜叶檀画的是什么。大胆猜一个最可能答案，再说一句很短的自然反应。只输出 JSON：{"guess":"最可能的答案，不超过16字","comment":"不超过45字","confidence":"high、medium 或 low"}';
      const result = await callModel({
        runtime,
        system,
        maxTokens: 260,
        temperature: 0.75,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: `image/${match[1].toLowerCase()}`, data: match[2] } },
            { type: 'text', text: prompt },
          ],
        }],
      });
      const data = requireObject(parseJsonObject(result.text), ['guess']);
      const confidence = ['high', 'medium', 'low'].includes(String(data.confidence || '').toLowerCase())
        ? String(data.confidence).toLowerCase()
        : 'medium';
      res.json({
        guess: compactLine(data.guess, 80),
        comment: compactLine(data.comment, 180) || '……我先保留一点尊严，猜这个。',
        confidence,
        model: result.model,
      });
    } catch (error) {
      console.error('[toybox:guess-drawing]', error.message);
      res.status(500).json({ error: error.message || '陆泽这次没看懂画' });
    }
  });
}

express.application.listen = function toyboxPatchedListen(...args) {
  registerToyboxRoutes(this);
  return originalListen.apply(this, args);
};

module.exports = {
  compactLine,
  safeList,
  clampInt,
  parseJsonObject,
  extractModelText,
  personaOnly,
  normalizeHarmonyRound,
  normalizeSecretRound,
  normalizeDrawingPrompt,
  registerToyboxRoutes,
};
