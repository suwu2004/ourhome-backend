'use strict';

const { createClient } = require('@supabase/supabase-js');
const { createToyboxStore } = require('./toyboxAssistant');

const express = require('express');
const originalListen = express.application.listen;
const STALE_USER_RUN_MS = 60 * 60 * 1000;
const AUTO_CLEAN_GAMES = ['harmony', 'secret'];
let registered = false;
let store = null;
let supabaseClient = null;

function getSupabase() {
  if (supabaseClient) return supabaseClient;
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_KEY || '').trim();
  if (!url || !key) throw new Error('Toybox Supabase 尚未配置');
  supabaseClient = createClient(url, key);
  return supabaseClient;
}

function getStore() {
  if (store) return store;
  store = createToyboxStore({ supabase: getSupabase() });
  return store;
}

function safeStatus(value) {
  const status = String(value || '').trim();
  return ['invited', 'active', 'completed', 'abandoned'].includes(status) ? status : null;
}

async function cleanupStaleUserRuns(now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_USER_RUN_MS).toISOString();
  const timestamp = now.toISOString();
  const { data, error } = await getSupabase()
    .from('toybox_runs')
    .update({ status: 'abandoned', completed_at: timestamp, updated_at: timestamp })
    .in('game', AUTO_CLEAN_GAMES)
    .eq('status', 'active')
    .eq('initiator', 'user')
    .lt('updated_at', cutoff)
    .select('id');
  if (error) throw error;
  return (data || []).length;
}

function registerToyboxSocialRoutes(app) {
  if (registered) return;
  registered = true;

  app.get('/toybox/history', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(100, Number.parseInt(req.query?.limit, 10) || 30));
      const runs = await getStore().listRuns({ limit, status: safeStatus(req.query?.status) });
      res.json({ runs });
    } catch (error) {
      console.error('[toybox:history]', error.message);
      res.status(500).json({ error: error.message || '游戏记录暂时打不开' });
    }
  });

  app.get('/toybox/open', async (_req, res) => {
    try {
      // Ordinary harmony/secret rounds have no resume UI once the user leaves the
      // game. Do not let those orphaned rows remain "active" forever and confuse
      // Luze's current-game lookup. One hour is deliberately generous; invited
      // rounds, Gomoku and Drawing are never auto-cleaned here.
      await cleanupStaleUserRuns().catch(error => console.warn('[toybox:stale-cleanup]', error.message));
      const runs = await getStore().getOpenRuns(20);
      res.json({ runs });
    } catch (error) {
      console.error('[toybox:open]', error.message);
      res.status(500).json({ error: error.message || '当前游戏状态暂时打不开' });
    }
  });

  app.get('/toybox/runs/:id', async (req, res) => {
    try {
      const run = await getStore().getRun(req.params.id, { includeEvents: true });
      if (!run) return res.status(404).json({ error: '找不到这局游戏' });
      res.json(run);
    } catch (error) {
      console.error('[toybox:run:get]', error.message);
      res.status(500).json({ error: error.message || '游戏记录暂时打不开' });
    }
  });

  app.post('/toybox/runs', async (req, res) => {
    try {
      const run = await getStore().createRun({
        game: req.body?.game,
        status: req.body?.status || 'active',
        initiator: req.body?.initiator || 'user',
        chatSessionId: req.body?.chat_session_id || null,
        title: req.body?.title || '',
        state: req.body?.state || {},
        result: req.body?.result || {},
        model: req.body?.model || null,
      });
      res.status(201).json(run);
    } catch (error) {
      console.error('[toybox:run:create]', error.message);
      res.status(400).json({ error: error.message || '这局游戏没有记下来' });
    }
  });

  app.patch('/toybox/runs/:id', async (req, res) => {
    try {
      const run = await getStore().updateRun(req.params.id, {
        status: req.body?.status,
        state: req.body?.state,
        result: req.body?.result,
        title: req.body?.title,
        model: req.body?.model,
      });
      res.json(run);
    } catch (error) {
      console.error('[toybox:run:update]', error.message);
      res.status(400).json({ error: error.message || '这局游戏没有更新成功' });
    }
  });

  app.post('/toybox/runs/:id/events', async (req, res) => {
    try {
      const event = await getStore().appendEvent(req.params.id, {
        actor: req.body?.actor || 'user',
        eventType: req.body?.event_type,
        payload: req.body?.payload || {},
      });
      res.status(201).json(event);
    } catch (error) {
      console.error('[toybox:event]', error.message);
      res.status(400).json({ error: error.message || '这一步没有记下来' });
    }
  });
}

express.application.listen = function toyboxSocialPatchedListen(...args) {
  registerToyboxSocialRoutes(this);
  return originalListen.apply(this, args);
};

module.exports = {
  STALE_USER_RUN_MS,
  AUTO_CLEAN_GAMES,
  cleanupStaleUserRuns,
  registerToyboxSocialRoutes,
};
