'use strict';

const { createClient } = require('@supabase/supabase-js');
const { isMainChatRequest } = require('./intimacyFlowSupport');
const { isLikelyVisionModel } = require('./modelCompatibility');

// Loaded after apiUsageAuditPatch and before backgroundAiCostGuardPatch.
// Chat and Theater keep the exact model chosen by the user. Toy Bear keeps its
// own existing budget selector. Lu Ze's private-room consent and real learning
// synthesis also keep the selected smart model; planning/rough work stays cheap.
const providerFetch = globalThis.fetch;
const MODEL_CACHE_MS = 5 * 60 * 1000;
const modelCache = new Map();
const SMART_BACKGROUND_PURPOSES = new Set([
  'luze-private-consent',
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

function isModelRequest(url, body) {
  if (!body || typeof body !== 'object' || !body.model) return false;
  const path = safeUrl(url)?.pathname || '';
  return /\/(?:messages|chat\/completions|responses)\/?$/i.test(path);
}

function isToyboxRequest(body) {
  const text = `${systemText(body?.system)}\n${messageText(body?.messages)}`;
  return text.includes('【玩具箱】') || text.includes('【玩具熊】');
}

function isTheaterRequest(body) {
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

function pickBudgetModel(models, { vision = false } = {}) {
  return [...new Set((Array.isArray(models) ? models : []).map(String).filter(Boolean))]
    .filter(isCandidate)
    .filter(model => !vision || isLikelyVisionModel(model))
    .sort((a, b) => budgetScore(a) - budgetScore(b) || String(a).localeCompare(String(b)))[0] || '';
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
  if (forced && (!vision || isLikelyVisionModel(forced))) return forced;

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
    if (selected && budgetScore(selected) <= 3.8 && (!vision || isLikelyVisionModel(selected))) return selected;
    return '';
  }
}

function inferPurpose(body) {
  const system = systemText(body?.system);
  const messages = messageText(body?.messages);
  const text = `${system}\n${messages}`;
  if (isVisionReaderRequest(body)) return 'vision-reader';
  if (/记忆日志/.test(text)) return 'memory-journal';
  if (/隐藏接续账本|滚动账本/.test(text)) return 'context-ledger';
  if (/公开邮箱|收到的邮件|邮件隐私/.test(text)) return 'agentmail';
  if (/窗口简介|分段压缩后的摘要|窗口已经分段/.test(text)) return 'session-summary';
  if (isTheaterRequest(body)) return 'theater';
  if (/幸福日记|心情日历/.test(text)) return 'daily-writing';
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

if (typeof providerFetch === 'function') {
  globalThis.fetch = async function nonChatBudgetFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (typeof init?.body !== 'string') return providerFetch(input, init);

    let body;
    try { body = JSON.parse(init.body); } catch { return providerFetch(input, init); }
    if (!isModelRequest(url, body)) return providerFetch(input, init);

    const purpose = requestPurpose(init);
    // Interactive Chat, Toy Bear, and Theater keep their own selected model.
    // Private-room consent and final learning synthesis are also deliberate
    // high-quality calls; planning/filtering stays behind the cheap-model guard.
    if (isMainChatRequest(url, body) || isToyboxRequest(body) || isTheaterRequest(body) || preservesRequestedModel(purpose)) {
      return providerFetch(input, init);
    }

    const vision = isVisionReaderRequest(body);
    const model = await cheapestModel({ vision });
    if (!model) {
      console.warn(`[budget-model] blocked paid non-chat call; no safe cheapest model purpose=${purpose || inferPurpose(body)} requested=${body.model || ''}`);
      return localBudgetError('当前 API 站点暂时没有拿到可确认的省钱模型，后台功能已停止这次调用，避免误用 Chat 的昂贵模型。');
    }

    const headers = new Headers(init.headers || undefined);
    if (!headers.has('X-OurHome-Call-Purpose')) headers.set('X-OurHome-Call-Purpose', inferPurpose(body));
    const originalModel = String(body.model || '');
    const nextBody = { ...body, model };
    if (originalModel !== model) console.log(`[budget-model] ${purpose || inferPurpose(body)} ${originalModel} -> ${model}`);
    return providerFetch(input, { ...init, headers, body: JSON.stringify(nextBody) });
  };
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function budgetModelHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      // Legacy policy marker retained for source-level regression compatibility:
      // cheapest-except-chat-toybear-theater-v2
      body = { ...body, non_chat_model_policy: 'tiered-learning-v3' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[budget-model] health marker unavailable:', error.message);
}

module.exports = {
  budgetScore,
  pickBudgetModel,
  isToyboxRequest,
  isTheaterRequest,
  isVisionReaderRequest,
  inferPurpose,
  requestPurpose,
  preservesRequestedModel,
};
