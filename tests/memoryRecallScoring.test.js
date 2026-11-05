'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_VECTOR_RELEVANCE_THRESHOLD,
  DEFAULT_KEYWORD_RELEVANCE_THRESHOLD,
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
