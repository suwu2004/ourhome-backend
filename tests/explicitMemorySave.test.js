'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExplicitMemorySummary, isExactMemoryDuplicate } = require('../explicitMemorySave');

test('explicit chat memory accepts clear facts even without policy keywords', () => {
  const result = normalizeExplicitMemorySummary('叶檀的猫叫泽叽，是她重要的家庭成员。');
  assert.equal(result.ok, true);
  assert.equal(result.summary, '叶檀的猫叫泽叽，是她重要的家庭成员。');
});

test('explicit chat memory normalizes whitespace before saving', () => {
  const result = normalizeExplicitMemorySummary('  叶檀   喜欢雨天和黑咖啡。  ');
  assert.equal(result.ok, true);
  assert.equal(result.summary, '叶檀 喜欢雨天和黑咖啡。');
});

test('explicit chat memory allows concise facts after explicit-save intent has selected the tool', () => {
  const result = normalizeExplicitMemorySummary('猫叫泽叽');
  assert.equal(result.ok, true);
  assert.equal(result.summary, '猫叫泽叽');
});

test('explicit chat memory rejects only empty and oversized summaries', () => {
  assert.equal(normalizeExplicitMemorySummary('   ').ok, false);
  assert.equal(normalizeExplicitMemorySummary('记'.repeat(261)).ok, false);
});

test('exact existing summaries are recognized as duplicates but distinct facts are retained', () => {
  assert.equal(isExactMemoryDuplicate('猫叫泽叽', '猫叫泽叽'), true);
  assert.equal(isExactMemoryDuplicate('猫叫泽叽', '猫叫泽叽，喜欢晒太阳'), false);
  assert.equal(isExactMemoryDuplicate('', '猫叫泽叽'), false);
});
