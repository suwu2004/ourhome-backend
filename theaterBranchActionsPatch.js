'use strict';

const { createClient } = require('@supabase/supabase-js');
const express = require('express');

const originalListen = express.application.listen;
let registered = false;
let supabaseClient = null;

const THEATER_BOOK_CATEGORY = '小剧本';
const THEATER_MESSAGE_CATEGORY = '小剧场';
const THEATER_HIDDEN_MESSAGE_CATEGORY = '小剧场·已收起';
const THEATER_MEMORY_CATEGORY = '小剧场记忆';
const THEATER_ARCHIVED_MEMORY_CATEGORY = '小剧场记忆·分支归档';
const MAX_RESTORE_IDS = 3000;

function getSupabase() {
  if (supabaseClient) return supabaseClient;
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_KEY || '').trim();
  if (!url || !key) throw new Error('小剧场分支操作缺少 Supabase 配置');
  supabaseClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabaseClient;
}

function normalizeMessageIds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(item => String(item || '').trim())
    .filter(Boolean))]
    .slice(0, MAX_RESTORE_IDS);
}

function selectBranchCutRows(rows, targetId, { includeTarget = false } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const index = list.findIndex(row => String(row?.id) === String(targetId));
  if (index < 0) return { index: -1, target: null, rows: [] };
  return {
    index,
    target: list[index],
    rows: list.slice(includeTarget ? index : index + 1),
  };
}

async function assertBook(client, bookId) {
  const { data, error } = await client.from('letters')
    .select('id,title')
    .eq('id', bookId)
    .eq('category', THEATER_BOOK_CATEGORY)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const notFound = new Error('找不到这本小剧本');
    notFound.status = 404;
    throw notFound;
  }
  return data;
}

async function listActiveMessages(client, bookId) {
  const { data, error } = await client.from('letters')
    .select('id,author,content,created_at,parent_id')
    .eq('category', THEATER_MESSAGE_CATEGORY)
    .eq('parent_id', bookId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function archiveActiveMemory(client, bookId) {
  const { data, error } = await client.from('letters')
    .update({ category: THEATER_ARCHIVED_MEMORY_CATEGORY })
    .eq('category', THEATER_MEMORY_CATEGORY)
    .eq('parent_id', bookId)
    .select('id');
  if (error) throw error;
  return (data || []).map(row => row.id);
}

async function hideRows(client, bookId, ids) {
  const messageIds = normalizeMessageIds(ids);
  if (!messageIds.length) return [];
  const { data, error } = await client.from('letters')
    .update({ category: THEATER_HIDDEN_MESSAGE_CATEGORY })
    .eq('parent_id', bookId)
    .eq('category', THEATER_MESSAGE_CATEGORY)
    .in('id', messageIds)
    .select('id');
  if (error) throw error;
  return (data || []).map(row => row.id);
}

async function restoreRows(client, bookId, ids) {
  const messageIds = normalizeMessageIds(ids);
  if (!messageIds.length) return [];
  const { data, error } = await client.from('letters')
    .update({ category: THEATER_MESSAGE_CATEGORY })
    .eq('parent_id', bookId)
    .eq('category', THEATER_HIDDEN_MESSAGE_CATEGORY)
    .in('id', messageIds)
    .select('id');
  if (error) throw error;
  return (data || []).map(row => row.id);
}

function sendRouteError(res, error, fallback) {
  const status = Number(error?.status) || 500;
  res.status(status).json({ error: error?.message || fallback });
}

function registerTheaterBranchRoutes(app) {
  if (registered) return;
  registered = true;

  app.post('/theater/books/:id/messages/:messageId/rollback', async (req, res) => {
    try {
      const client = getSupabase();
      const bookId = req.params.id;
      const messageId = req.params.messageId;
      await assertBook(client, bookId);
      const rows = await listActiveMessages(client, bookId);
      const cut = selectBranchCutRows(rows, messageId, { includeTarget: false });
      if (cut.index < 0) return res.status(404).json({ error: '找不到要回到的这条消息' });
      if (!cut.rows.length) return res.json({ hiddenIds: [], hiddenCount: 0 });

      // A branch change makes the old structured memory unsafe. Preserve the row
      // as an archive instead of deleting it; the next Theater reply will rebuild
      // from the active branch through the existing cheap memory path.
      await archiveActiveMemory(client, bookId);
      const hiddenIds = await hideRows(client, bookId, cut.rows.map(row => row.id));
      res.json({ hiddenIds, hiddenCount: hiddenIds.length });
    } catch (error) {
      sendRouteError(res, error, '小剧场没有回到这里');
    }
  });

  app.post('/theater/books/:id/messages/:messageId/edit-prepare', async (req, res) => {
    try {
      const client = getSupabase();
      const bookId = req.params.id;
      const messageId = req.params.messageId;
      await assertBook(client, bookId);
      const rows = await listActiveMessages(client, bookId);
      const cut = selectBranchCutRows(rows, messageId, { includeTarget: true });
      if (cut.index < 0) return res.status(404).json({ error: '找不到要重新编辑的这条消息' });
      if (cut.target?.author !== '檀') return res.status(400).json({ error: '只能重新编辑你自己发出的消息' });

      await archiveActiveMemory(client, bookId);
      const hiddenIds = await hideRows(client, bookId, cut.rows.map(row => row.id));
      res.json({ hiddenIds, hiddenCount: hiddenIds.length });
    } catch (error) {
      sendRouteError(res, error, '这条消息暂时没有进入编辑分支');
    }
  });

  app.post('/theater/books/:id/messages/:messageId/rollback/undo', async (req, res) => {
    try {
      const client = getSupabase();
      const bookId = req.params.id;
      await assertBook(client, bookId);
      const requestedIds = normalizeMessageIds(req.body?.message_ids);
      if (!requestedIds.length) return res.json({ restoredIds: [] });

      // Restoring an older branch is also a timeline change, so any memory built
      // after the rollback becomes an archive before the old messages return.
      await archiveActiveMemory(client, bookId);
      const restoredIds = await restoreRows(client, bookId, requestedIds);
      res.json({ restoredIds });
    } catch (error) {
      sendRouteError(res, error, '小剧场这次没有恢复成功');
    }
  });
}

express.application.listen = function theaterBranchActionsPatchedListen(...args) {
  registerTheaterBranchRoutes(this);
  return originalListen.apply(this, args);
};

module.exports = {
  THEATER_MESSAGE_CATEGORY,
  THEATER_HIDDEN_MESSAGE_CATEGORY,
  THEATER_MEMORY_CATEGORY,
  THEATER_ARCHIVED_MEMORY_CATEGORY,
  normalizeMessageIds,
  selectBranchCutRows,
  registerTheaterBranchRoutes,
};
