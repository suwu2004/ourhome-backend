'use strict';

const { validateRemoteUrl } = require('./integrations');

const VISUAL_REQUEST_RE = /(?:看看|看一下|看下|看这(?:张|个)|看照片|看图|照片(?:里|中)|图(?:里|中)|画面|长什么样|什么样子|仔细看看|帮我看看|辨认|识别(?:一下)?|描述(?:一下)?(?:照片|图片|图)|照片里有什么|图片里有什么)/iu;
const MAX_PHOTOS_PER_TURN = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const VISION_READER_SYSTEM = 'OurHome 的图片代读器。你是一个低成本、只负责看图的后台工具。根据用户问题和提供的图片，客观提取与问题有关的视觉事实。不要聊天，不要调用工具，不要猜测看不见的内容；无法确认时明确说无法确认。只输出简洁的图片观察结果，供另一个聊天模型继续回答。';

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

function extractText(responsePayload) {
  if (!responsePayload) return '';
  if (typeof responsePayload === 'string') return responsePayload.trim();
  if (Array.isArray(responsePayload?.content)) {
    return responsePayload.content.map(block => typeof block === 'string' ? block : block?.text || '').filter(Boolean).join('\n').trim();
  }
  if (typeof responsePayload?.output_text === 'string') return responsePayload.output_text.trim();
  if (Array.isArray(responsePayload?.output)) {
    return responsePayload.output.flatMap(item => Array.isArray(item?.content) ? item.content : [item])
      .map(item => item?.text || item?.content || '').filter(value => typeof value === 'string').join('\n').trim();
  }
  if (Array.isArray(responsePayload?.choices)) {
    return responsePayload.choices.map(choice => {
      const content = choice?.message?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.map(block => block?.text || '').filter(Boolean).join('\n');
      return '';
    }).filter(Boolean).join('\n').trim();
  }
  return '';
}

function currentUserQuestion(messages) {
  return [...(messages || [])].reverse().find(message => message?.role === 'user' && typeof message.content === 'string')?.content || '';
}

function replacePhotoToolResultWithAnalysis(messages, analysis) {
  const next = [...messages];
  const match = [...next].map((message, i) => ({ message, i })).reverse().find(item => photoToolResultMessage(item.message));
  if (!match) return next;
  const message = match.message;
  const original = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n')
      : '';
  next[match.i] = {
    ...message,
    content: `${original}\n\n[图片代读结果]\n${analysis}`.trim(),
  };
  return next;
}

async function runCheapVisionReader(providerUrl, providerOptions, images, userQuestion) {
  if (!images.length) return '';
  const text = String(userQuestion || '').trim().slice(0, 2000) || '请描述这些图片中与当前问题有关的视觉事实。';
  const body = {
    model: providerOptions.model,
    system: VISION_READER_SYSTEM,
    max_tokens: 700,
    temperature: 0,
    messages: [{ role: 'user', content: [{ type: 'text', text }, ...images] }],
  };
  const headers = new Headers(providerOptions.headers || undefined);
  headers.set('X-OurHome-Call-Purpose', 'vision-reader');
  const response = await globalThis.fetch(providerUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    console.warn(`[photo-memory-vision] reader status ${response.status}`);
    return '';
  }
  try { return extractText(await response.json()); } catch { return ''; }
}

async function handleVisionRequest(url, options, body, messages) {
  const photoMemories = collectPhotoMemoriesFromValue(messages).filter(item => item?.image_url);
  if (!photoMemories.length) return null;

  const images = [];
  const imageFetch = globalThis.__ourhomePhotoVisionPreviousFetch || globalThis.fetch;
  for (const memory of photoMemories.slice(0, MAX_PHOTOS_PER_TURN)) {
    try { images.push(await fetchImageBlock(imageFetch, memory.image_url)); }
    catch (error) { console.warn(`[photo-memory-vision] skipped ${memory.title || 'photo'}: ${error.message}`); }
  }
  if (!images.length) return null;

  const analysis = await runCheapVisionReader(url, {
    model: body.model,
    headers: Object.fromEntries(new Headers(options.headers || undefined).entries()),
  }, images, currentUserQuestion(messages));
  if (!analysis) return null;
  return replacePhotoToolResultWithAnalysis(messages, analysis);
}

function installPhotoMemoryVisionBridge() {
  const previousFetch = globalThis.fetch;
  if (typeof previousFetch !== 'function') return;
  globalThis.__ourhomePhotoVisionPreviousFetch = previousFetch;
  globalThis.fetch = async function photoMemoryVisionFetch(url, options = {}) {
    if (!isMessagesEndpoint(url) || String(options?.method || 'GET').toUpperCase() !== 'POST' || typeof options.body !== 'string') {
      return previousFetch(url, options);
    }
    let body;
    try { body = JSON.parse(options.body); } catch { return previousFetch(url, options); }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length || alreadyHasVisionImages(messages) || !hasVisualRequest(messages)) return previousFetch(url, options);
    const patchedMessages = await handleVisionRequest(url, options, body, messages).catch(error => {
      console.warn('[photo-memory-vision] reader failed:', error.message);
      return null;
    });
    if (!patchedMessages) return previousFetch(url, options);
    return previousFetch(url, { ...options, body: JSON.stringify({ ...body, messages: patchedMessages }) });
  };
  globalThis.photoMemoryVisionBridge = { installed: true, maxPhotos: MAX_PHOTOS_PER_TURN, mode: 'cheap-vision-reader' };
}

installPhotoMemoryVisionBridge();

module.exports = { VISUAL_REQUEST_RE, VISION_READER_SYSTEM, collectPhotoMemoriesFromValue, hasVisualRequest, addPhotoImagesToToolResult: (messages, images) => {
  if (!images.length) return messages;
  const next = [...messages];
  const match = [...next].map((message, i) => ({ message, i })).reverse().find(item => photoToolResultMessage(item.message));
  if (!match) return next;
  const text = Array.isArray(match.message.content)
    ? match.message.content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n')
    : String(match.message.content || '');
  next[match.i] = { ...match.message, content: [{ type: 'text', text }, ...images] };
  return next;
}, extractText };