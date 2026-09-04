'use strict';

const { validateRemoteUrl } = require('./integrations');

const VISUAL_REQUEST_RE = /(?:看看|看一下|看下|看这(?:张|个)|看照片|看图|照片(?:里|中)|图(?:里|中)|画面|长什么样|什么样子|仔细看看|帮我看看|辨认|识别(?:一下)?|描述(?:一下)?(?:照片|图片|图)|照片里有什么|图片里有什么)/iu;
const MAX_PHOTOS_PER_TURN = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function isMessagesEndpoint(url) {
  try { return new URL(url).pathname.endsWith('/messages'); } catch { return false; }
}

function collectPhotoMemoriesFromValue(value, target = []) {
  if (target.length >= MAX_PHOTOS_PER_TURN || value == null) return target;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.includes('photo_memories')) return target;
    try { collectPhotoMemoriesFromValue(JSON.parse(trimmed), target); } catch {}
    const start = trimmed.indexOf('[');
    const end = trimmed.indexOf(']</ourhome_tool_result>');
    if (start >= 0 && end > start) {
      try { collectPhotoMemoriesFromValue(JSON.parse(trimmed.slice(start, end + 1)), target); } catch {}
    }
    return target;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectPhotoMemoriesFromValue(item, target));
    return target;
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.photo_memories)) {
      value.photo_memories.forEach(item => {
        if (target.length < MAX_PHOTOS_PER_TURN && item?.image_url) target.push(item);
      });
    }
    Object.entries(value).forEach(([key, child]) => {
      if (key !== 'photo_memories') collectPhotoMemoriesFromValue(child, target);
    });
  }
  return target;
}

function hasVisualRequest(messages) {
  return (messages || []).some(message => {
    if (message?.role !== 'user') return false;
    if (typeof message.content === 'string') return VISUAL_REQUEST_RE.test(message.content);
    if (Array.isArray(message.content)) return message.content.some(block => block?.type === 'text' && VISUAL_REQUEST_RE.test(block.text || ''));
    return false;
  });
}

function alreadyHasVisionImages(messages) {
  return (messages || []).some(message => Array.isArray(message?.content)
    && message.content.some(block => block?.type === 'image' && block?.source?.data));
}

async function fetchImageBlock(fetchImpl, url) {
  const safeUrl = await validateRemoteUrl(url);
  const response = await fetchImpl(safeUrl, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`图片读取失败 (${response.status})`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_IMAGE_BYTES) throw new Error('图片过大');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('图片过大');
  const mediaType = String(response.headers.get('content-type') || '').split(';')[0].trim();
  if (!mediaType.startsWith('image/')) throw new Error('地址没有返回图片');
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } };
}

function photoToolResultMessage(message) {
  if (message?.role !== 'user') return false;
  if (typeof message.content === 'string') return message.content.includes('photo_memories');
  if (Array.isArray(message.content)) return message.content.some(block => String(block?.content || '').includes('photo_memories'));
  return false;
}

function addPhotoImagesToToolResult(messages, images) {
  if (!images.length) return messages;
  const next = [...messages];
  const match = [...next].map((message, i) => ({ message, i })).reverse().find(item => photoToolResultMessage(item.message));
  if (!match) return next;
  const message = match.message;
  const text = Array.isArray(message.content)
    ? message.content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n')
    : String(message.content || '');
  next[match.i] = { ...message, content: [{ type: 'text', text }, ...images] };
  return next;
}

function installPhotoMemoryVisionBridge() {
  const previousFetch = globalThis.fetch;
  if (typeof previousFetch !== 'function') return;
  globalThis.fetch = async function photoMemoryVisionFetch(url, options = {}) {
    if (!isMessagesEndpoint(url) || String(options?.method || 'GET').toUpperCase() !== 'POST' || typeof options.body !== 'string') {
      return previousFetch(url, options);
    }
    let body;
    try { body = JSON.parse(options.body); } catch { return previousFetch(url, options); }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length || alreadyHasVisionImages(messages) || !hasVisualRequest(messages)) return previousFetch(url, options);
    const photoMemories = collectPhotoMemoriesFromValue(messages).filter(item => item?.image_url);
    if (!photoMemories.length) return previousFetch(url, options);

    const images = [];
    for (const memory of photoMemories.slice(0, MAX_PHOTOS_PER_TURN)) {
      try { images.push(await fetchImageBlock(previousFetch, memory.image_url)); }
      catch (error) { console.warn(`[photo-memory-vision] skipped ${memory.title || 'photo'}: ${error.message}`); }
    }
    if (!images.length) return previousFetch(url, options);
    const patchedMessages = addPhotoImagesToToolResult(messages, images);
    return previousFetch(url, { ...options, body: JSON.stringify({ ...body, messages: patchedMessages }) });
  };
  globalThis.photoMemoryVisionBridge = { installed: true, maxPhotos: MAX_PHOTOS_PER_TURN };
}

installPhotoMemoryVisionBridge();

module.exports = { VISUAL_REQUEST_RE, collectPhotoMemoriesFromValue, hasVisualRequest, addPhotoImagesToToolResult };
