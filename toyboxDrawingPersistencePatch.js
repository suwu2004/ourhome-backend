'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const { installPrivateBucketGuard } = require('./privateUploads');

const DRAWING_ACTIVE_WINDOW_MS = 2 * 60 * 60 * 1000;
const UPLOAD_BUCKET = process.env.SUPABASE_UPLOAD_BUCKET || 'uploads';
let supabaseClient = null;
let uploadBucketReady = false;

function getSupabase() {
  if (supabaseClient) return supabaseClient;
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_KEY || '').trim();
  if (!url || !key) throw new Error('Toybox Supabase 尚未配置');
  supabaseClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  // This patch owns its own Supabase client, so install the same private-bucket
  // guard used by the rest of OurHome instead of relying on the server client.
  installPrivateBucketGuard(supabaseClient, UPLOAD_BUCKET);
  return supabaseClient;
}

function parseDataImage(value) {
  const match = String(value || '').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  const kind = match[1].toLowerCase();
  return {
    buffer: Buffer.from(match[2], 'base64'),
    contentType: `image/${kind}`,
    extension: kind === 'jpeg' ? 'jpg' : kind,
  };
}

async function ensureUploadBucket() {
  if (uploadBucketReady) return;
  const supabase = getSupabase();
  const existing = await supabase.storage.getBucket(UPLOAD_BUCKET);
  if (existing.error) {
    const missing = existing.error.statusCode === '404' || /not found/i.test(existing.error.message || '');
    if (!missing) throw existing.error;
    const created = await supabase.storage.createBucket(UPLOAD_BUCKET, {
      public: false,
      fileSizeLimit: 12 * 1024 * 1024,
    });
    if (created.error) throw created.error;
  } else if (existing.data?.public === true) {
    // Never make the shared attachment bucket public just to show a Drawing.
    const updated = await supabase.storage.updateBucket(UPLOAD_BUCKET, {
      public: false,
      fileSizeLimit: 12 * 1024 * 1024,
    });
    if (updated.error) throw updated.error;
  }
  uploadBucketReady = true;
}

async function uploadDrawing(image) {
  const parsed = parseDataImage(image);
  if (!parsed) return '';
  await ensureUploadBucket();
  const supabase = getSupabase();
  const path = `toybox/drawings/${Date.now()}-${crypto.randomUUID()}.${parsed.extension}`;
  const uploaded = await supabase.storage.from(UPLOAD_BUCKET).upload(path, parsed.buffer, {
    contentType: parsed.contentType,
    upsert: false,
  });
  if (uploaded.error) throw uploaded.error;
  // Keep the stable canonical object reference in the database. OurHome's existing
  // private upload middleware signs it only when sending it back to the browser.
  return supabase.storage.from(UPLOAD_BUCKET).getPublicUrl(path).data?.publicUrl || '';
}

async function latestActiveDrawing() {
  const cutoff = new Date(Date.now() - DRAWING_ACTIVE_WINDOW_MS).toISOString();
  const { data, error } = await getSupabase().from('toybox_runs')
    .select('*')
    .eq('game', 'drawing')
    .eq('status', 'active')
    .gte('updated_at', cutoff)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function persistDrawingGuess(req, guessBody) {
  const supabase = getSupabase();
  let imageUrl = '';
  try {
    imageUrl = await uploadDrawing(req.body?.image);
  } catch (error) {
    console.warn('[toybox:drawing-save] image upload unavailable:', error.message);
  }

  const now = new Date().toISOString();
  const active = await latestActiveDrawing();
  if (active?.id) {
    const state = {
      ...(active.state && typeof active.state === 'object' ? active.state : {}),
      ...(imageUrl ? { image_url: imageUrl } : {}),
      drawing_saved_at: now,
    };
    const { data, error } = await supabase.from('toybox_runs')
      .update({ state, model: guessBody.model || active.model || null, updated_at: now })
      .eq('id', active.id)
      .select('id')
      .single();
    if (error) throw error;
    return { id: data.id, imageUrl, createdFreestyle: false };
  }

  const result = {
    guess: String(guessBody.guess || '').slice(0, 80),
    comment: String(guessBody.comment || '').slice(0, 180),
    confidence: String(guessBody.confidence || 'medium'),
    ...(imageUrl ? { image_url: imageUrl } : {}),
  };
  const state = {
    prompt: '自由画',
    ...(imageUrl ? { image_url: imageUrl } : {}),
    drawing_saved_at: now,
  };
  const { data: run, error } = await supabase.from('toybox_runs').insert({
    game: 'drawing',
    status: 'completed',
    initiator: 'user',
    title: '你画我猜 · 自由画',
    state,
    result,
    model: guessBody.model || null,
    completed_at: now,
    updated_at: now,
  }).select('*').single();
  if (error) throw error;

  const event = await supabase.from('toybox_events').insert({
    run_id: run.id,
    actor: 'luze',
    event_type: 'guess_drawing',
    payload: {
      guess: result.guess,
      comment: result.comment,
      confidence: result.confidence,
      ...(imageUrl ? { image_url: imageUrl } : {}),
    },
  });
  if (event.error) console.warn('[toybox:drawing-save] event write unavailable:', event.error.message);
  return { id: run.id, imageUrl, createdFreestyle: true };
}

const originalJson = express.response.json;
express.response.json = function toyboxDrawingPersistenceJson(body) {
  const req = this.req;
  const path = String(req?.path || req?.originalUrl || '').split('?')[0];
  const shouldPersist = path === '/toybox/guess-drawing'
    && this.statusCode < 400
    && body?.guess
    && req?.body?.image;
  if (!shouldPersist) return originalJson.call(this, body);

  const res = this;
  persistDrawingGuess(req, body)
    .then(saved => {
      if (res.headersSent) return;
      originalJson.call(res, {
        ...body,
        record_saved: true,
        record_id: saved.id,
        image_url: saved.imageUrl || undefined,
        freestyle_record: saved.createdFreestyle,
      });
    })
    .catch(error => {
      console.error('[toybox:drawing-save]', error.message);
      if (res.headersSent) return;
      originalJson.call(res, {
        ...body,
        record_saved: false,
        record_error: error.message || '画作记录没有保存成功',
      });
    });
  return this;
};

module.exports = { parseDataImage, persistDrawingGuess };
