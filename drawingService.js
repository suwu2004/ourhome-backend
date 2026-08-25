'use strict';

const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { createUploadSigner, installPrivateBucketGuard } = require('./privateUploads');

const CONNECTION_KIND = 'image_generation';
const CONNECTION_NAME = '画画 API';
const DEFAULT_BASE_URL = 'https://jixiangai.lol/v1';
const DEFAULT_MODEL = 'GPT-magic2';
const BUCKET = 'uploads';
const HISTORY_LIMIT = 60;
const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

let supabaseClient = null;
let signer = null;
const requests = new Map();

function compactLine(value, max = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function getSupabase() {
  if (supabaseClient) return supabaseClient;
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_KEY || '').trim();
  if (!url || !key) throw new Error('画室还没有接上 Supabase');
  supabaseClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  installPrivateBucketGuard(supabaseClient, BUCKET);
  signer = createUploadSigner({ supabase: supabaseClient, bucket: BUCKET });
  return supabaseClient;
}

function imagesEndpoint(baseUrl) {
  const clean = compactLine(baseUrl || DEFAULT_BASE_URL, 1600).replace(/\/+$/, '');
  if (/\/images\/generations$/i.test(clean)) return clean;
  return `${clean}/images/generations`;
}

function imageExtension(contentType) {
  const value = String(contentType || '').toLowerCase();
  if (value.includes('jpeg') || value.includes('jpg')) return 'jpg';
  if (value.includes('webp')) return 'webp';
  if (value.includes('gif')) return 'gif';
  return 'png';
}

function decodeBase64Image(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const buffer = Buffer.from(text, 'base64');
    if (!buffer.length) return null;
    return { buffer, contentType: 'image/png' };
  } catch {
    return null;
  }
}

function parseDataUrl(value) {
  const text = String(value || '').trim();
  if (!/^data:image\//i.test(text)) return null;
  const match = text.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return null;
  try {
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length) return null;
    return { buffer, contentType: match[1] };
  } catch {
    return null;
  }
}

function looksLikeBase64(value) {
  const text = String(value || '').trim();
  return text.length >= 128 && text.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

function parseImagePayload(payload = {}) {
  const seen = new Set();
  const maxDepth = 7;

  function visit(value, key = '', depth = 0) {
    if (value == null || depth > maxDepth) return null;

    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return null;
      const dataUrl = parseDataUrl(text);
      if (dataUrl) return dataUrl;
      if (/^https?:\/\//i.test(text) && /(url|image|src|href|result|output|content|data)/i.test(key)) return { url: text };
      if (/(b64|base64|image_data|imageData)/i.test(key) && looksLikeBase64(text)) return decodeBase64Image(text);
      if (/(result|output|image|content|data)/i.test(key) && looksLikeBase64(text)) return decodeBase64Image(text);
      return null;
    }

    if (typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        const result = visit(item, key, depth + 1);
        if (result) return result;
      }
      return null;
    }

    const preferredKeys = [
      'b64_json', 'b64Json', 'base64', 'base64_data', 'image_data', 'imageData',
      'data_url', 'dataUrl', 'url', 'image_url', 'imageUrl', 'image', 'result', 'output',
    ];
    for (const childKey of preferredKeys) {
      if (!(childKey in value)) continue;
      const result = visit(value[childKey], childKey, depth + 1);
      if (result) return result;
    }

    for (const [childKey, childValue] of Object.entries(value)) {
      if (preferredKeys.includes(childKey)) continue;
      const result = visit(childValue, childKey, depth + 1);
      if (result) return result;
    }
    return null;
  }

  return visit(payload);
}

async function imageConnection({ includeSecret = false } = {}) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('service_connections')
    .select('*')
    .eq('kind', CONNECTION_KIND)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  let secret = null;
  if (includeSecret && data.secret_id) {
    const result = await supabase.rpc('ourhome_get_service_secret', { p_connection_id: data.id });
    if (result.error) throw result.error;
    secret = Array.isArray(result.data) ? result.data[0] : result.data;
  }
  return { ...data, secret: secret || null };
}

async function getDrawingConfig() {
  const connection = await imageConnection();
  return {
    id: connection?.id || null,
    name: connection?.name || CONNECTION_NAME,
    base_url: connection?.url || DEFAULT_BASE_URL,
    model: compactLine(connection?.config?.model || DEFAULT_MODEL, 240),
    enabled: connection ? connection.enabled !== false : true,
    has_api_key: Boolean(connection?.secret_id),
  };
}

async function saveDrawingConfig(input = {}) {
  const existing = await imageConnection();
  const baseUrl = compactLine(input.base_url || existing?.url || DEFAULT_BASE_URL, 1600);
  const model = compactLine(input.model || existing?.config?.model || DEFAULT_MODEL, 240);
  const apiKey = typeof input.api_key === 'string' ? input.api_key.trim() : '';
  if (!baseUrl) throw new Error('请填写画画 API 网址');
  if (!model) throw new Error('请填写画画模型');
  const { data, error } = await getSupabase().rpc('ourhome_save_service_connection', {
    p_id: existing?.id || null,
    p_kind: CONNECTION_KIND,
    p_name: CONNECTION_NAME,
    p_url: baseUrl,
    p_secret: apiKey || null,
    p_enabled: input.enabled !== false,
    p_config: { ...(existing?.config || {}), model },
  });
  if (error) throw error;
  return getDrawingConfig();
}

async function loadRuntime() {
  const connection = await imageConnection({ includeSecret: true });
  if (!connection || connection.enabled === false) throw new Error('画画 API 还没有启用');
  if (!connection.secret) throw new Error('画画 API 还没有保存密钥');
  const model = compactLine(connection.config?.model || DEFAULT_MODEL, 240);
  return { provider: connection.name || CONNECTION_NAME, baseUrl: connection.url || DEFAULT_BASE_URL, apiKey: String(connection.secret), model };
}

async function fetchGeneratedBytes(parsed) {
  if (parsed?.buffer) {
    if (!parsed.buffer.length || parsed.buffer.length > MAX_IMAGE_BYTES) throw new Error('生成图片大小异常');
    return parsed;
  }
  if (!parsed?.url) throw new Error('生图接口没有返回图片');
  const response = await fetch(parsed.url, { signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`图片下载失败 (${response.status})`);
  const arrayBuffer = await response.arrayBuffer();
  if (!arrayBuffer.byteLength || arrayBuffer.byteLength > MAX_IMAGE_BYTES) throw new Error('生成图片大小异常');
  return { buffer: Buffer.from(arrayBuffer), contentType: response.headers.get('content-type') || 'image/png' };
}

async function callImageProvider(runtime, prompt) {
  const response = await fetch(imagesEndpoint(runtime.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runtime.apiKey}`, 'X-OurHome-Call-Purpose': 'drawing-room' },
    body: JSON.stringify({ model: runtime.model, prompt, n: 1 }),
    signal: AbortSignal.timeout(120_000),
  });

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    const rawError = await response.text();
    let payload = {};
    try { payload = JSON.parse(rawError); } catch { /* keep raw text */ }
    const message = payload?.error?.message || payload?.message || rawError.slice(0, 500);
    throw new Error(`画画 API 暂时没有回应 (${response.status})${message ? `：${message}` : ''}`);
  }

  // Some OpenAI-compatible gateways return the image bytes directly instead of JSON.
  if (/^image\//i.test(contentType)) {
    const arrayBuffer = await response.arrayBuffer();
    if (!arrayBuffer.byteLength || arrayBuffer.byteLength > MAX_IMAGE_BYTES) throw new Error('生成图片大小异常');
    return { buffer: Buffer.from(arrayBuffer), contentType: contentType.split(';')[0] || 'image/png' };
  }

  const raw = await response.text();
  let payload = null;
  try { payload = JSON.parse(raw.replace(/^\uFEFF/, '').trim()); } catch { payload = null; }

  // A gateway may return a bare URL/data URL/base64 string instead of a JSON object.
  const parsed = parseImagePayload(payload ?? { output: raw });
  if (!parsed) {
    const detail = compactLine(raw, 260);
    throw new Error(`生图接口返回了无法识别的图片格式${detail ? `：${detail}` : `（Content-Type: ${contentType || '未知'}）`}`);
  }
  return fetchGeneratedBytes(parsed);
}

async function signHistory(rows) {
  getSupabase();
  const paths = rows.map(row => row.image_path).filter(Boolean);
  const signed = await signer.signMany(paths);
  return rows.map(row => ({ id: row.id, prompt: row.prompt, image: signed.get(row.image_path) || '', image_path: row.image_path, provider: row.provider, model: row.model, source: row.source, created_at: row.created_at }));
}

async function listDrawingHistory(limit = 24) {
  const safeLimit = Math.max(1, Math.min(HISTORY_LIMIT, Number.parseInt(limit, 10) || 24));
  const { data, error } = await getSupabase().from('drawing_history').select('*').order('created_at', { ascending: false }).limit(safeLimit);
  if (error) throw error;
  return signHistory(data || []);
}

async function persistDrawing({ prompt, bytes, runtime, source, requestId }) {
  const supabase = getSupabase();
  const ext = imageExtension(bytes.contentType);
  const day = new Date().toISOString().slice(0, 10);
  const imagePath = `drawing-room/${day}/${crypto.randomUUID()}.${ext}`;
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(imagePath, bytes.buffer, { contentType: bytes.contentType || 'image/png', cacheControl: String(30 * 24 * 60 * 60), upsert: false });
  if (uploadError) throw uploadError;
  const row = { prompt, image_path: imagePath, provider: runtime.provider, model: runtime.model, source: source === 'chat' ? 'chat' : 'drawing-room', metadata: requestId ? { request_id: requestId } : {} };
  const { data, error } = await supabase.from('drawing_history').insert(row).select('*').single();
  if (error) { await supabase.storage.from(BUCKET).remove([imagePath]).catch(() => {}); throw error; }
  return (await signHistory([data]))[0];
}

function cleanupRequests() {
  const cutoff = Date.now() - REQUEST_TTL_MS;
  for (const [key, item] of requests) if (item.createdAt < cutoff) requests.delete(key);
}

async function generateDrawing({ prompt, requestId = '', source = 'drawing-room' } = {}) {
  const cleanPrompt = compactLine(prompt, 1200);
  if (!cleanPrompt) throw new Error('先告诉我想画什么');
  cleanupRequests();
  const key = compactLine(requestId, 160);
  if (key && requests.has(key)) return requests.get(key).promise;
  const promise = (async () => {
    const runtime = await loadRuntime();
    const bytes = await callImageProvider(runtime, cleanPrompt);
    return persistDrawing({ prompt: cleanPrompt, bytes, runtime, source, requestId: key });
  })();
  if (key) requests.set(key, { createdAt: Date.now(), promise });
  try { return await promise; }
  catch (error) { if (key) requests.delete(key); throw error; }
}

async function deleteDrawing(id) {
  const cleanId = compactLine(id, 80);
  if (!cleanId) throw new Error('缺少画作编号');
  const supabase = getSupabase();
  const { data, error } = await supabase.from('drawing_history').select('*').eq('id', cleanId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('找不到这张画');
  if (data.image_path) {
    const removal = await supabase.storage.from(BUCKET).remove([data.image_path]);
    if (removal.error) throw removal.error;
  }
  const deleted = await supabase.from('drawing_history').delete().eq('id', cleanId);
  if (deleted.error) throw deleted.error;
  return { ok: true, id: cleanId };
}

async function downloadDrawing(id) {
  const cleanId = compactLine(id, 80);
  const supabase = getSupabase();
  const { data, error } = await supabase.from('drawing_history').select('id,prompt,image_path').eq('id', cleanId).maybeSingle();
  if (error) throw error;
  if (!data?.image_path) throw new Error('找不到这张画');
  const file = await supabase.storage.from(BUCKET).download(data.image_path);
  if (file.error || !file.data) throw file.error || new Error('图片读取失败');
  const arrayBuffer = await file.data.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType: file.data.type || 'image/png', filename: `ourhome-drawing-${String(data.id).slice(0, 8)}.${imageExtension(file.data.type)}` };
}

module.exports = { CONNECTION_KIND, DEFAULT_BASE_URL, DEFAULT_MODEL, imagesEndpoint, parseImagePayload, getDrawingConfig, saveDrawingConfig, listDrawingHistory, generateDrawing, deleteDrawing, downloadDrawing };
