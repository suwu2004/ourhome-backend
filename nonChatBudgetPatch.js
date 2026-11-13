'use strict';

const { createClient } = require('@supabase/supabase-js');
const { isLikelyVisionModel } = require('./modelCompatibility');

// Loaded after apiUsageAuditPatch and before backgroundAiCostGuardPatch.
// Chat and interactive Theater keep the exact model chosen by the user. Toy Bear
// keeps its own existing budget selector. Background Theater memory is deliberately
// excluded from that exemption and uses the cheapest safe model on the active site.
// Happiness Diary prose and Lu Ze's final learning notes follow the active Chat
// model; planning, search and other rough work stay cheap.
const providerFetch = globalThis.fetch;
const MODEL_CACHE_MS = 5 * 60 * 1000;
const HEARTBEAT_BACKOFF_MS = 60 * 60 * 1000;
const AUTOMATION_HEARTBEAT_PURPOSE = 'automation-heartbeat';
const SESSION_SUMMARY_AUTO_PURPOSE = 'session-summary-auto';
const modelCache = new Map();
let heartbeatBackoffUntil = 0;
const SMART_BACKGROUND_PURPOSES = new Set([
  'happiness-diary',
  'luze-learning-synthesis',
  'luze-learning-deep',
]);

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_KEY && typeof providerFetch === 'function'
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
      global: { fetch: providerFetch },
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

function safeUrl(value) {
  try { return new URL(String(value || '')); } catch { return null; }
}

function buildEndpoint(base, path) {
  const clean = String(base || '').trim().replace(/\/+$/, '');
  return clean.endsWith(path) ? clean : `${clean}${path}`;
}

function systemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map(block => typeof block === 'string' ? block : block?.text || block?.content || '')
    .filter(Boolean)
    .join('\n');
}

function messageText(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map(message => {
      if (typeof message?.content === 'string') return message.content;
      if (!Array.isArray(message?.content)) return '';
      return message.content
        .map(block => typeof block === 'string' ? block : block?.text || '')
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

function requestPurpose(init = {}) {
  try { return String(new Headers(init.headers || undefined).get('X-OurHome-Call-Purpose') || '').trim(); }
  catch { return ''; }
}

function preservesRequestedModel(purpose) {
  return SMART_BACKGROUND_PURPOSES.has(String(purpose || '').trim());
}

function shouldPreserveRequestedModelForCall(purpose, body = {}) {
  const task = String(purpose || '').trim();
  // Explicit task purpose is authoritative. Background jobs often reuse the full
  // personal system prompt, which may mention Toy Bear or Theater without being
  // an interactive request. Never let those incidental words bypass the budget.
  if (task === 'chat') return !isAgentMailReadRequest(body);
  if (task === 'toybox' || task === 'theater') return true;
  return preservesRequestedModel(task);
}

function isModelRequest(url, body) {
  if (!body || typeof body !== 'object' || !body.model) return false;
  const path = safeUrl(url)?.pathname || '';
  return /\/(?:messages|chat\/completions|responses)\/?$/i.test(path);
}

function hasAgentMailTool(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools.some(tool => {
    const text = `${tool?.name || ''} ${tool?.description || ''}`.toLowerCase();
    return /agentmail|邮箱|邮件|inbox|mail/.test(text);
  });
}

function isAgentMailReadRequest(body) {
  const system = systemText(body?.system);
  if (!system.includes('【回复长度】') || !system.includes('【OurHome 房间与入口认知（事实规则）】')) return false;
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const names = tools.map(tool => String(tool?.name || '').toLowerCase());
  const hasReadTool = names.some(name => /check_agentmail_inbox|read_agentmail_message|read_agentmail_activity/.test(name));
  if (!hasReadTool) return false;
  const text = systemText(body?.system) + '\\n' + messageText(body?.messages);
  // Chat exposes the full AgentMail toolset on both read and write turns, so
  // the mere presence of send/reply tools cannot identify a write. Decide from
  // the actual request intent instead: reading/checking stays cheap; composing,
  // sending, or replying keeps the model selected by the user.
  if (/写邮件|撰写邮件|写一封|发邮件|发送邮件|寄邮件|回复邮件|回邮件|回信|send\\s+email|write\\s+email|draft\\s+email|reply\\s+to|reply\\s+email/i.test(text)) {
    return false;
  }
  return /查看|检查|读取|读邮件|收件箱|来信|邮件内容|查看邮件|mail|inbox/i.test(text);
}

function isToyboxRequest(body) {
  const text = `${systemText(body?.system)}\n${messageText(body?.messages)}`;
  return text.includes('【玩具箱】') || text.includes('【玩具熊】');
}

function isTheaterMemoryRequest(body) {
  const system = systemText(body?.system);
  return system.includes('角色与剧情记忆整理器');
}

function isTheaterRequest(body) {
  if (isTheaterMemoryRequest(body)) return false;
  const text = `${systemText(body?.system)}\n${messageText(body?.messages)}`;
  return /小剧场|互动写作引擎|剧本名/.test(text);
}

function isVisionReaderRequest(body) {
  return systemText(body?.system).includes('OurHome 的图片代读器');
}

function isCandidate(model) {
  const value = String(model || '').toLowerCase();
  if (!value) return false;
  return !/(embedding|rerank|tts|whisper|audio|image[-_ ]?gen|dall[-_ ]?e|stable[-_ ]?diffusion|moderation|ocr|transcrib)/i.test(value);
}

function explicitPriceHint(model) {
  const value = String(model || '').toLowerCase();
  const matches = [...value.matchAll(/(?:^|[-_\[(（])(?:x|price|cost)?\s*(0\.\d{1,4})(?=[\])）_\-])/g)]
    .map(match => Number(match[1]))
    .filter(number => Number.isFinite(number) && number > 0 && number < 1);
  return matches.length ? Math.min(...matches) : null;
}

function budgetScore(model) {
  const value = String(model || '').toLowerCase();
  const explicit = explicitPriceHint(value);
  if (explicit !== null) return explicit;
  let score = 50;
  if (/flash[-_ ]?lite|nano/.test(value)) score = 1;
  else if (/haiku|mini|lite|small/.test(value)) score = 2;
  else if (/flash|instant/.test(value)) score = 3;
  else if (/sonnet/.test(value)) score = 7;
  else if (/opus|pro|max/.test(value)) score = 12;
  if (/thinking|reasoning/.test(value)) score += 0.8;
  return score;
}

function isFlashModel(model) {
  return /flash/i.test(String(model || ''));
}

function isGemini38FlashModel(model) {
  // Provider/router prefixes are allowed; match the Gemini 3.8 Flash model
  // identity anywhere in the exposed model ID.
  return /gemini[-_.]?3[._-]8.*flash/i.test(String(model || ''));
}

function pickBudgetModel(models, { vision = false } = {}) {
  return [...new Set((Array.isArray(models) ? models : []).map(String).filter(Boolean))]
    .filter(isCandidate)
    .filter(isFlashModel)
    .filter(model => !vision || isLikelyVisionModel(model))
    .sort((a, b) =>
      Number(isGemini38FlashModel(b)) - Number(isGemini38FlashModel(a))
      || budgetScore(a) - budgetScore(b)
      || String(a).localeCompare(String(b))
    )[0] || '';
}

function parseModels(payload) {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
  return source
    .map(item => typeof item === 'string' ? item : item?.id || item?.model || item?.name || '')
    .map(String)
    .filter(Boolean);
}

async function activeProfileRuntime() {
  if (!supabase) return null;
  const { data: profile, error } = await supabase.from('api_profiles')
    .select('id,name,base_url,selected_model')
    .eq('is_active', true)
    .maybeSingle();
  if (error || !profile?.id || !profile?.base_url) {
    if (error) console.warn('[budget-model] active profile lookup failed:', error.message);
    return null;
  }
  const { data: secretData, error: secretError } = await supabase.rpc('ourhome_get_api_profile_secret', { p_profile_id: profile.id });
  if (secretError) {
    console.warn('[budget-model] profile secret lookup failed:', secretError.message);
    return null;
  }
  const apiKey = Array.isArray(secretData) ? secretData[0] : secretData;
  if (!apiKey) return null;
  return { ...profile, apiKey: String(apiKey) };
}

async function fetchAvailableModels(runtime) {
  const endpoint = buildEndpoint(runtime.base_url, '/models');
  const response = await providerFetch(endpoint, {
    method: 'GET',
    headers: {
      'x-api-key': runtime.apiKey,
      Authorization: `Bearer ${runtime.apiKey}`,
      'anthropic-version': '2023-06-01',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`models status ${response.status}`);
  return parseModels(await response.json());
}

async function cheapestModel({ vision = false } = {}) {
  const forced = String(process.env.NON_CHAT_MODEL || '').trim();
  // Background routing is intentionally Flash-only. Even an explicit override
  // must not silently reintroduce a premium non-Flash model.
  if (forced && isFlashModel(forced) && (!vision || isLikelyVisionModel(forced))) return forced;

  const runtime = await activeProfileRuntime();
  if (!runtime) return '';
  const key = `${runtime.id}:${runtime.base_url}:${vision ? 'vision' : 'text'}`;
  const cached = modelCache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.model;

  try {
    const models = await fetchAvailableModels(runtime);
    const model = pickBudgetModel(models, { vision });
    modelCache.set(key, { model, expiresAt: Date.now() + MODEL_CACHE_MS });
    if (model) console.log(`[budget-model] profile=${runtime.name || runtime.id} ${vision ? 'vision ' : ''}cheapest=${model}`);
    return model;
  } catch (error) {
    console.warn('[budget-model] model list unavailable:', error.message);
    // Never silently fall back to an expensive active Chat model. A model that is
    // already clearly in the low-cost family may still be used as a safe fallback.
    const selected = String(runtime.selected_model || '').trim();
    if (selected && isFlashModel(selected) && budgetScore(selected) <= 3.8 && (!vision || isLikelyVisionModel(selected))) return selected;
    return '';
  }
}

function inferPurpose(body) {
  const system = systemText(body?.system);
  const messages = messageText(body?.messages);
  const text = `${system}\n${messages}`;
  if (isVisionReaderRequest(body)) return 'vision-reader';
  if (isTheaterMemoryRequest(body)) return 'theater-memory';
  if (/自动心跳提醒你|主动敲门/.test(text)) return AUTOMATION_HEARTBEAT_PURPOSE;
  if (/记忆日志/.test(text)) return 'memory-journal';
  if (/隐藏接续账本|滚动账本/.test(text)) return 'context-ledger';
  if (/公开邮箱|收到的邮件|邮件隐私/.test(text)) return 'agentmail';
  if (/窗口简介|分段压缩后的摘要|窗口已经分段/.test(text)) return SESSION_SUMMARY_AUTO_PURPOSE;
  if (isToyboxRequest(body)) return 'toybox';
  if (isTheaterRequest(body)) return 'theater';
  if (/幸福日记/.test(text)) return 'happiness-diary';
  if (/心情日历/.test(text)) return 'daily-mood';
  return 'non-chat-budget';
}

function localBudgetError(message) {
  return new Response(JSON.stringify({
    error: { message, type: 'ourhome_budget_model_unavailable' },
  }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json',
      'X-OurHome-Local-Response': 'budget-model-guard',
    },
  });
}

function isHeartbeatPurpose(purpose) {
  return String(purpose || '').trim() === AUTOMATION_HEARTBEAT_PURPOSE;
}

if (typeof providerFetch === 'function') {
  globalThis.fetch = async function nonChatBudgetFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (typeof init?.body !== 'string') return providerFetch(input, init);

    let body;
    try { body = JSON.parse(init.body); } catch { return providerFetch(input, init); }
    if (!isModelRequest(url, body)) return providerFetch(input, init);

    const explicitPurpose = requestPurpose(init);
    const agentMailRead = isAgentMailReadRequest(body);
    const effectivePurpose = agentMailRead ? 'agentmail-read' : (explicitPurpose || inferPurpose(body));
    const heartbeat = isHeartbeatPurpose(effectivePurpose);

    // Explicit task purpose is authoritative. Background jobs may reuse the
    // same base persona prompt as Chat, so shared prompt markers must not grant
    // them the foreground pricing exemption. Diary prose and final learning-note
    // synthesis are the deliberate exceptions; other background work stays cheap.
    if (shouldPreserveRequestedModelForCall(effectivePurpose, body)) {
      return providerFetch(input, init);
    }

    if (heartbeat && heartbeatBackoffUntil > Date.now()) {
      return localBudgetError('主动消息线路刚刚不可用，后台已进入一小时冷却，避免每次心跳重复请求。');
    }

    const vision = isVisionReaderRequest(body);
    const model = await cheapestModel({ vision });
    if (!model) {
      console.warn(`[budget-model] blocked paid non-chat call; no safe cheapest model purpose=${effectivePurpose} requested=${body.model || ''}`);
      if (heartbeat) heartbeatBackoffUntil = Date.now() + HEARTBEAT_BACKOFF_MS;
      return localBudgetError('当前 API 站点暂时没有拿到可确认的省钱模型，后台功能已停止这次调用，避免误用 Chat 的昂贵模型。');
    }

    const headers = new Headers(init.headers || undefined);
    headers.set('X-OurHome-Call-Purpose', effectivePurpose);
    const originalModel = String(body.model || '');
    const nextBody = { ...body, model };
    if (originalModel !== model) console.log(`[budget-model] ${effectivePurpose} ${originalModel} -> ${model}`);
    let response;
    try {
      response = await providerFetch(input, { ...init, headers, body: JSON.stringify(nextBody) });
    } catch (error) {
      // Network timeouts throw instead of returning a 5xx response. They must
      // enter the same cooldown or the next heartbeat can repeat the same slow call.
      if (heartbeat) heartbeatBackoffUntil = Date.now() + HEARTBEAT_BACKOFF_MS;
      throw error;
    }
    if (heartbeat) {
      if (response.status >= 500) heartbeatBackoffUntil = Date.now() + HEARTBEAT_BACKOFF_MS;
      else if (response.ok) heartbeatBackoffUntil = 0;
    }
    return response;
  };
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function budgetModelHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      // Legacy policy marker retained for source-level regression compatibility:
      // cheapest-except-chat-toybear-theater-v2
      body = { ...body, non_chat_model_policy: 'chat-writing-v6-cheap-heartbeat-theater-memory' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[budget-model] health marker unavailable:', error.message);
}

module.exports = {
  AUTOMATION_HEARTBEAT_PURPOSE,
  SESSION_SUMMARY_AUTO_PURPOSE,
  budgetScore,
  isFlashModel,
  isGemini38FlashModel,
  pickBudgetModel,
  isToyboxRequest,
  isTheaterMemoryRequest,
  isTheaterRequest,
  isVisionReaderRequest,
  hasAgentMailTool,
  isAgentMailReadRequest,
  inferPurpose,
  isHeartbeatPurpose,
  requestPurpose,
  preservesRequestedModel,
  shouldPreserveRequestedModelForCall,
  cheapestModel,
};
