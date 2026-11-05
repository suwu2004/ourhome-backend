'use strict';

const DEFAULT_VECTOR_RELEVANCE_THRESHOLD = 0.18;
const DEFAULT_KEYWORD_RELEVANCE_THRESHOLD = 0.08;

function isMemoryRecallRelevant({
  vectorScore = 0,
  keywordScore = 0,
  hasVector = false,
  vectorThreshold = DEFAULT_VECTOR_RELEVANCE_THRESHOLD,
  keywordThreshold = DEFAULT_KEYWORD_RELEVANCE_THRESHOLD,
} = {}) {
  const vector = Number(vectorScore) || 0;
  const keyword = Number(keywordScore) || 0;
  const safeVectorThreshold = Math.max(0, Number(vectorThreshold) || DEFAULT_VECTOR_RELEVANCE_THRESHOLD);
  const safeKeywordThreshold = Math.max(0, Number(keywordThreshold) || DEFAULT_KEYWORD_RELEVANCE_THRESHOLD);
  return (Boolean(hasVector) && vector >= safeVectorThreshold) || keyword >= safeKeywordThreshold;
}

function sampleQueryBigrams(value, limit = 24) {
  const text = String(value || '');
  const max = Math.max(1, Math.min(64, Number.parseInt(limit, 10) || 24));
  const unique = [];
  const seen = new Set();
  for (let index = 0; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);
    if (seen.has(pair)) continue;
    seen.add(pair);
    unique.push(pair);
  }
  if (unique.length <= max) return unique;
  if (max === 1) return [unique[0]];
  const sampled = [];
  for (let index = 0; index < max; index += 1) {
    const position = Math.round(index * (unique.length - 1) / (max - 1));
    const pair = unique[position];
    if (pair && !sampled.includes(pair)) sampled.push(pair);
  }
  return sampled;
}

module.exports = {
  DEFAULT_VECTOR_RELEVANCE_THRESHOLD,
  DEFAULT_KEYWORD_RELEVANCE_THRESHOLD,
  sampleQueryBigrams,
  isMemoryRecallRelevant,
};
