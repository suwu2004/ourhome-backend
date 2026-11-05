'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { localChunkDigest, selectedModelChunkIndexes } = require('../sessionSummaryEconomyPatch');

test('local summary fallback never copies raw dialogue or roleplay actions', () => {
  const privateLine = '2026-11-04 16:00 陆泽：我听见你在我怀里带着哭腔说出这句“我也不知道怎么说”，心口又是一阵发紧。';
  const prompt = '这是第 5/12 段聊天记录。\n聊天段落：\n2026-11-04 16:00 叶檀：今天有点难过。\n' + privateLine + '\n输出不超过260字';
  const digest = localChunkDigest(prompt);
  assert.match(digest, /情绪与陪伴/);
  assert.doesNotMatch(digest, /我听见你|哭腔|心口又是一阵发紧|今天有点难过/);
  assert.match(digest, /情境互动和情绪陪伴/);
});

test('local summary fallback returns a neutral metadata digest for ordinary chat', () => {
  const prompt = '聊天段落：\n2026-11-04 16:00 叶檀：我今天在学校准备作文课。\n2026-11-04 16:01 陆泽：我帮你整理教学安排。\n输出不超过260字';
  const digest = localChunkDigest(prompt);
  assert.match(digest, /教学与学校/);
  assert.doesNotMatch(digest, /我今天在学校|我帮你整理/);
});

test('model-backed chunks are distributed across the entire conversation', () => {
  assert.deepEqual(selectedModelChunkIndexes(12), [1, 5, 8, 12]);
  assert.deepEqual(selectedModelChunkIndexes(3), [1, 2, 3]);
  assert.deepEqual(selectedModelChunkIndexes(1), [1]);
});
