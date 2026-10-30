'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MIN_SIGNAL,
  MEMORY_JOURNAL_MIN_SIGNAL,
  signalLength,
  shouldAnalyzeMemoryJournalTurn,
} = require('../memoryJournalTrigger');

test('short conversational turns do not launch background memory model calls', () => {
  for (const userText of ['嗯嗯', '好呀', '亲亲', '抱抱', '继续', '晚安']) {
    assert.equal(
      shouldAnalyzeMemoryJournalTurn({ userText, assistantText: '这是一段很长的回复，里面提到了 OurHome 项目、API 和部署。'.repeat(12) }),
      false,
      userText,
    );
  }
});

test('explicit save requests, stable preferences, and meaningful project changes still trigger', () => {
  assert.equal(shouldAnalyzeMemoryJournalTurn({ userText: '请记住我喜欢清楚自然的讲解方式，以后不要把回复写成重复的套话。' }), true);
  assert.equal(shouldAnalyzeMemoryJournalTurn({ userText: 'OurHome 的 API 请求过多，需要排查并修复记忆调用频率。' }), true);
  assert.equal(shouldAnalyzeMemoryJournalTurn({ userText: '今天确认了新的高一课表和教学安排。' }), true);
});

test('an attachment marker without a meaningful caption does not trigger a second model call', () => {
  assert.equal(shouldAnalyzeMemoryJournalTurn({ userText: '[发送了附件：一张图片]' }), false);
  assert.equal(shouldAnalyzeMemoryJournalTurn({ userText: '[发送了附件：一张图片] 请帮我把这张课表整理进长期项目记录。' }), true);
});

test('long user-authored messages use the user signal only, never assistant verbosity', () => {
  assert.equal(DEFAULT_MIN_SIGNAL, 220);
  assert.ok(MEMORY_JOURNAL_MIN_SIGNAL >= 200);
  assert.equal(signalLength('🥺 你好，世界！'), 4);
  assert.equal(shouldAnalyzeMemoryJournalTurn({ userText: '甲'.repeat(230), assistantText: '' }), true);
  assert.equal(shouldAnalyzeMemoryJournalTurn({ userText: '好', assistantText: '甲'.repeat(500) }), false);
});
