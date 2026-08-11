'use strict';

const sharp = require('sharp');

const DEFAULT_MIN_BYTES = 768 * 1024;
const DEFAULT_MAX_EDGE = 2048;
const DEFAULT_TARGET_BYTES = 950 * 1024;
const DEFAULT_MIN_SAVINGS_RATIO = 0.08;
const STATIC_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

function normalizeImageType(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  return type === 'image/jpg' ? 'image/jpeg' : type;
}

function isCompressibleImageType(value) {
  return STATIC_IMAGE_TYPES.has(normalizeImageType(value));
}

function outputOptions(type, quality, effort = 4) {
  if (type === 'image/jpeg') return { format: 'jpeg', options: { quality, mozjpeg: true } };
  if (type === 'image/webp') return { format: 'webp', options: { quality, effort } };
  if (type === 'image/avif') return { format: 'avif', options: { quality: Math.max(45, quality - 24), effort } };
  return { format: 'png', options: { compressionLevel: 9, adaptiveFiltering: true, effort: 10 } };
}

async function encodeImage(input, type, { maxEdge, quality }) {
  const { format, options } = outputOptions(type, quality);
  return sharp(input, { failOn: 'none', limitInputPixels: 100_000_000 })
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .toFormat(format, options)
    .toBuffer();
}

async function compressImageBuffer(input, contentType, {
  minBytes = DEFAULT_MIN_BYTES,
  maxEdge = DEFAULT_MAX_EDGE,
  targetBytes = DEFAULT_TARGET_BYTES,
  minSavingsRatio = DEFAULT_MIN_SAVINGS_RATIO,
} = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const type = normalizeImageType(contentType);
  if (!isCompressibleImageType(type)) return { buffer, contentType: type || contentType, compressed: false, reason: 'unsupported' };
  if (buffer.length < Math.max(1, minBytes)) return { buffer, contentType: type, compressed: false, reason: 'small' };

  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'none', limitInputPixels: 100_000_000 }).metadata();
  } catch {
    return { buffer, contentType: type, compressed: false, reason: 'decode-failed' };
  }
  if (Number(metadata.pages || 1) > 1) return { buffer, contentType: type, compressed: false, reason: 'animated' };

  const attempts = type === 'image/png'
    ? [{ maxEdge, quality: 100 }, { maxEdge: Math.min(maxEdge, 1600), quality: 100 }]
    : [
      { maxEdge, quality: 82 },
      { maxEdge: Math.min(maxEdge, 1728), quality: 78 },
      { maxEdge: Math.min(maxEdge, 1440), quality: 74 },
    ];
  let smallest = buffer;
  for (const attempt of attempts) {
    try {
      const candidate = await encodeImage(buffer, type, attempt);
      if (candidate.length < smallest.length) smallest = candidate;
      if (candidate.length <= targetBytes) break;
    } catch {
      return { buffer, contentType: type, compressed: false, reason: 'encode-failed' };
    }
  }

  const savedBytes = buffer.length - smallest.length;
  if (savedBytes <= 0 || savedBytes / buffer.length < minSavingsRatio) {
    return { buffer, contentType: type, compressed: false, reason: 'low-savings' };
  }
  return {
    buffer: smallest,
    contentType: type,
    compressed: true,
    originalBytes: buffer.length,
    outputBytes: smallest.length,
    savedBytes,
  };
}

module.exports = {
  DEFAULT_MIN_BYTES,
  DEFAULT_MAX_EDGE,
  DEFAULT_TARGET_BYTES,
  normalizeImageType,
  isCompressibleImageType,
  compressImageBuffer,
};
