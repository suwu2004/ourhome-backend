const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  compressImageBuffer,
  isCompressibleImageType,
  normalizeImageType,
} = require('../imageCompression');

test('normalizes static image types and excludes animated containers', () => {
  assert.equal(normalizeImageType('image/jpg'), 'image/jpeg');
  assert.equal(isCompressibleImageType('image/jpeg'), true);
  assert.equal(isCompressibleImageType('image/gif'), false);
});

test('shrinks a large photo while preserving its media type', async () => {
  const width = 3200;
  const height = 2400;
  const pixels = Buffer.allocUnsafe(width * height * 3);
  for (let index = 0; index < pixels.length; index += 3) {
    const pixel = index / 3;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    pixels[index] = (x * 17 + y * 11) % 256;
    pixels[index + 1] = (x * 7 + y * 19) % 256;
    pixels[index + 2] = (x * 13 + y * 5) % 256;
  }
  const raw = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 100 })
    .toBuffer();
  const result = await compressImageBuffer(raw, 'image/jpeg', { minBytes: 1 });
  assert.equal(result.compressed, true);
  assert.equal(result.contentType, 'image/jpeg');
  assert.ok(result.buffer.length < raw.length * 0.92);
  const metadata = await sharp(result.buffer).metadata();
  assert.ok(Math.max(metadata.width, metadata.height) <= 2048);
});

test('leaves small images byte-for-byte unchanged', async () => {
  const raw = await sharp({
    create: { width: 64, height: 64, channels: 3, background: '#f0c986' },
  }).png().toBuffer();
  const result = await compressImageBuffer(raw, 'image/png');
  assert.equal(result.compressed, false);
  assert.equal(result.buffer, raw);
});
