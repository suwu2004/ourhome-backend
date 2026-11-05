'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_VECTOR_RELEVANCE_THRESHOLD,
  DEFAULT_KEYWORD_RELEVANCE_THRESHOLD,
  sampleQueryBigrams,
  isMemoryRecallRelevant,
} = require('../memoryRecallScoring');

test('freshness and stored weight cannot make an unrelated memory relevant', () => {
  assert.equal(isMemoryRecallRelevant({ vectorScore: 0, keywordScore: 0, hasVector: true }), false);
  assert.equal(isMemoryRecallRelevant({ vectorScore: 0, keywordScore: 0, hasVector: false }), false);
});

test('a meaningful vector or keyword match can qualify a memory', () => {
  assert.equal(isMemoryRecallRelevant({
    vectorScore: DEFAULT_VECTOR_RELEVANCE_THRESHOLD,
    keywordScore: 0,
    hasVector: true,
  }), true);
  assert.equal(isMemoryRecallRelevant({
    vectorScore: 0,
    keywordScore: DEFAULT_KEYWORD_RELEVANCE_THRESHOLD,
    hasVector: false,
  }), true);
});

test('vector scores without an available embedding do not qualify on their own', () => {
  assert.equal(isMemoryRecallRelevant({
    vectorScore: 0.9,
    keywordScore: 0,
    hasVector: false,
  }), false);
});


test('keyword sampling is case-insensitive and normalizes full-width Latin characters', () => {
  const mixedCase = sampleQueryBigrams('OurHome GitHub');
  assert.ok(mixedCase.includes('ou'));
  assert.ok(mixedCase.includes('gi'));

  const fullWidth = sampleQueryBigrams('ＧＩＴＨＵＢ');
  assert.ok(fullWidth.includes('gi'));
  assert.ok(fullWidth.includes('it'));
});

test('keyword sampling covers the start, middle and end of long messages', () => {
  const text = Array.from({ length: 70 }, (_, index) => String.fromCharCode(0x4e00 + index)).join('');
  const sampled = sampleQueryBigrams(text, 6);
  assert.equal(sampled.length, 6);
  assert.ok(sampled.some(pair => text.indexOf(pair) < 5));
  assert.ok(sampled.some(pair => text.indexOf(pair) > 40));
  assert.ok(sampled.some(pair => text.indexOf(pair) > 60));
});
