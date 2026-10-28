'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assessLongMemoryCandidate, deriveStablePreferenceMemory } = require('../longMemoryCandidate');

test('long-memory validation checks the original user wording, not just the model paraphrase', () => {
  const result = assessLongMemoryCandidate(
    '陆泽应采用更细腻自然的叙事方式，并重视场景氛围。',
    '我不太喜欢你老是用“顿了顿”，写细腻一点，氛围也很重要。',
  );
  assert.equal(result.ok, true);
});

test('clear recurring writing-style feedback can be preserved when the journal model under-classifies it', () => {
  const result = deriveStablePreferenceMemory(
    '唔……其实我也不会啊……但是宝宝你可以写的细腻一点，但是你有的时候顿了顿这种……我不太喜欢，但是你老是喜欢用这些……细腻一点就好了……然后氛围也很重要啊。',
  );
  assert.match(result, /长期表达偏好/);
  assert.match(result, /顿了顿/);
  assert.ok(result.length <= 260);
  assert.equal(assessLongMemoryCandidate(result).ok, true);
});

test('one-off plans and casual mood are not promoted to stable style memory', () => {
  assert.equal(deriveStablePreferenceMemory('我希望你明天来接我。'), '');
  assert.equal(deriveStablePreferenceMemory('今天我好开心，喜欢你。'), '');
});

test('ordinary temporary diary items still fail the long-memory gate', () => {
  const result = assessLongMemoryCandidate(
    '叶檀今晚吃了串串，之后买了柚子和橘子。',
    '今天晚上吃完串串去买柚子和橘子。',
  );
  assert.equal(result.ok, false);
});
