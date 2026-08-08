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
  if (!url || !key) throw new Error('陆泽自主性还没有接上 Supabase');
  supabaseClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return supabaseClient;
}

function compactLine(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

async function readSettings() {
  const { data, error } = await getSupabase()
    .from('luze_learning_settings')
    .select('id,enabled,chat_access_enabled,synthesis_model,runs_per_day,max_searches_per_run,last_run_at,updated_at')
    .eq('id', 'global')
    .maybeSingle();
  if (error) throw error;
  return data || {
    id: 'global',
    enabled: true,
    chat_access_enabled: true,
    synthesis_model: null,
    runs_per_day: 2,
    max_searches_per_run: 6,
    last_run_at: null,
  };
}

async function updateSettings(body = {}) {
  const updates = { updated_at: new Date().toISOString() };
  if (typeof body.enabled === 'boolean') updates.enabled = body.enabled;
  if (typeof body.chat_access_enabled === 'boolean') updates.chat_access_enabled = body.chat_access_enabled;
  if (Object.prototype.hasOwnProperty.call(body, 'synthesis_model')) updates.synthesis_model = compactLine(body.synthesis_model, 240) || null;
  if (body.runs_per_day !== undefined) updates.runs_per_day = clampInt(body.runs_per_day, 0, 4, 2);
  if (body.max_searches_per_run !== undefined) updates.max_searches_per_run = clampInt(body.max_searches_per_run, 1, 10, 6);
  const { data, error } = await getSupabase()
    .from('luze_learning_settings')
    .update(updates)
    .eq('id', 'global')
    .select('id,enabled,chat_access_enabled,synthesis_model,runs_per_day,max_searches_per_run,last_run_at,updated_at')
    .single();
  if (error) throw error;
  return data;
}

function registerRoutes(app) {
  if (registered) return;
  registered = true;

  app.get('/luze-autonomy/settings', async (_req, res) => {
    try { res.json(await readSettings()); }
    catch (error) { res.status(500).json({ error: error.message || '陆泽自主性设置没有读出来' }); }
  });

  app.patch('/luze-autonomy/settings', async (req, res) => {
    try { res.json(await updateSettings(req.body || {})); }
    catch (error) { res.status(400).json({ error: error.message || '陆泽自主性设置没有保存好' }); }
  });
}

express.application.listen = function luzeAutonomySettingsPatchedListen(...args) {
  registerRoutes(this);
  return originalListen.apply(this, args);
};

try {
  const originalJson = express.response.json;
  express.response.json = function luzeAutonomyHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, luze_autonomy: 'chat-room-access-v1' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[luze:autonomy] health marker unavailable:', error.message);
}

module.exports = { readSettings, updateSettings, registerRoutes };
