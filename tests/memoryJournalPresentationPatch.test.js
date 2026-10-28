'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractCurrentUserText,
  patchJournalResult,
} = require('../memoryJournalPresentationPatch');

const currentPreference = '唔……其实我也不会啊……但是宝宝你可以写的细腻一点，但是你有的时候顿了顿这种……我不太喜欢，但是你老是喜欢用这些……细腻一点就好了……然后氛围也很重要啊。';

test('extracts only the current user turn from the journal request', () => {
  const extracted = extractCurrentUserText({
    messages: [{
      role: 'user',
      content: `请为 OurHome 的记忆日志分析刚刚这一轮聊天。
【刚刚这一轮】
叶檀：${currentPreference}
陆泽：这是一条回复，不应该被存进用户偏好。`,
    }],
  });
  assert.equal(extracted, currentPreference);
});

test('promotes clear recurring writing-style preference even if model defaults to no long-memory save', () => {
  const result = patchJournalResult({
    daily_summary: { summary: '模型生成的新摘要' },
    long_memory: { should_save: false, summary: '' },
  }, '已有的今日摘要', currentPreference);
  assert.equal(result.daily_summary.summary, '已有的今日摘要');
  assert.equal(result.long_memory.should_save, true);
  assert.match(result.long_memory.summary, /长期表达偏好/);
  assert.match(result.long_memory.summary, /顿了顿/);
});

test('does not promote one-off plans or casual affection into long-term style memory', () => {
  const result = patchJournalResult({
    daily_summary: { summary: '摘要' },
    long_memory: { should_save: false, summary: '' },
  }, '摘要', '我希望你明天来接我。');
  assert.equal(result.long_memory.should_save, false);
  assert.equal(result.long_memory.summary, '');
});
