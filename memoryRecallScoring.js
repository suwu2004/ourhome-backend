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

module.exports = {
  DEFAULT_VECTOR_RELEVANCE_THRESHOLD,
  DEFAULT_KEYWORD_RELEVANCE_THRESHOLD,
  isMemoryRecallRelevant,
};
