'use strict';

const { createClient } = require('@supabase/supabase-js');
const { createToyboxStore } = require('./toyboxAssistant');

const express = require('express');
const originalListen = express.application.listen;
let registered = false;
let store = null;

function getStore() {
  if (store) return store;
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_KEY || '').trim();
  if (!url || !key) throw new Error('Toybox Supabase 尚未配置');
  const supabase = createClient(url, key);
  store = createToyboxStore({ supabase });
  return store;
}

function safeStatus(value) {
  const status = String(value || '').trim();
  return ['invited', 'active', 'completed', 'abandoned'].includes(status) ? status : null;
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

module.exports = { registerToyboxSocialRoutes };
