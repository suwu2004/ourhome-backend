'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLearningPlanResult, requestLearningPlanWithFallback } = require('../luzeLearningPlanFallback');

test('keeps a valid model-generated learning plan', () => {
  const result = normalizeLearningPlanResult({
    query: '为什么金属饰品会氧化？',
    reason: '刚好想弄明白。',
    keywords: ['金属', '氧化', '保养'],
  }, 'curiosity');
  assert.equal(result.query, '为什么金属饰品会氧化？');
  assert.equal(result.reason, '刚好想弄明白。');
  assert.deepEqual(result.keywords, ['金属', '氧化', '保养']);
  assert.equal(result.usedFallback, false);
});

test('uses a zero-cost OurHome topic when model JSON has no query', () => {
  const result = normalizeLearningPlanResult({ reason: '我想看看' }, 'ourhome');
  assert.match(result.query, /长对话/);
  assert.match(result.query, /token/);
  assert.equal(result.usedFallback, true);
  assert.ok(result.keywords.includes('OurHome'));
});

test('uses a curiosity topic when planning output is empty or malformed', () => {
  for (const input of [null, {}, 'not json']) {
    const result = normalizeLearningPlanResult(input, 'curiosity');
    assert.match(result.query, /围巾/);
    assert.equal(result.usedFallback, true);
  }
});

test('compacts keywords and caps query lengths', () => {
  const result = normalizeLearningPlanResult({
    query: '  ' + '问题'.repeat(250) + '  ',
    keywords: ['  长对话  ', '长对话', '', '记忆'],
  }, 'ourhome');
  assert.equal(result.query.length, 360);
  assert.deepEqual(result.keywords, ['长对话', '记忆']);
});


test('uses a zero-cost local plan when the planning provider is unavailable', async () => {
  const result = await requestLearningPlanWithFallback(async () => {
    throw new Error('陆泽的学习模型暂时没有回应 (503)');
  }, 'ourhome');

  assert.match(result.query, /长对话/);
  assert.equal(result.usedFallback, true);
  assert.equal(result.requestFailed, true);
  assert.match(result.failureReason, /503/);
});

test('keeps a valid plan when the planning request succeeds', async () => {
  const result = await requestLearningPlanWithFallback(async () => ({
    query: '为什么雨后空气闻起来不一样？',
    reason: '今天下过雨。',
    keywords: ['雨', '气味'],
  }), 'curiosity');

  assert.equal(result.query, '为什么雨后空气闻起来不一样？');
  assert.equal(result.usedFallback, false);
  assert.equal(result.requestFailed, false);
  assert.equal(result.failureReason, '');
});
