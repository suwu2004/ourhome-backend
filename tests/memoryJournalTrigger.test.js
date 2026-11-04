'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MIN_SIGNAL,
  MEMORY_JOURNAL_MIN_SIGNAL,
  signalLength,
  shouldAnalyzeMemoryJournalTurn,
  isRecentLifeUpdate,
  isMemoryContinuationCue,
  shouldAnalyzeMemoryJournalContinuation,
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

test('short actionable work requests enter the zero-cost memory path', () => {
  for (const userText of ['宝宝你帮我检查一下这个问题', '帮我核对这份材料', '这个分镜再改一下']) {
    assert.equal(shouldAnalyzeMemoryJournalTurn({ userText }), true, userText);
  }
});


test('meaningful recent life updates trigger capture without a task verb', () => {
  for (const userText of [
    '我最近开始做 AI 动漫了，现在在熟悉分镜流程。',
    '这几天学校事情比较多，我在带高一语文。',
    '今天去学校给学生上课，回来还整理了教案。',
    '这周我开始准备教师资格考试。',
    '最近我和同事闹了点矛盾。',
    '我最近连续几天睡不好。',
    '我刚刚在看你每天写的幸福日记，我感觉好幸福。',
    '我最近在考虑换工作，也在学视频剪辑。',
    '我这会儿正在整理教案和学生作文。',
  ]) {
    assert.equal(isRecentLifeUpdate(userText), true, userText);
    assert.equal(shouldAnalyzeMemoryJournalTurn({ userText }), true, userText);
  }
  for (const userText of ['我今天有点困', '我刚买了杯拿铁', '今天的天气不错', '我刚刚想你了']) {
    assert.equal(isRecentLifeUpdate(userText), false, userText);
    assert.equal(shouldAnalyzeMemoryJournalTurn({ userText }), false, userText);
  }
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

test('explicit temporary-memory maintenance requests trigger analysis even when short', () => {
  assert.equal(shouldAnalyzeMemoryJournalTurn({ userText: '临时记忆更新感觉有点慢' }), true);
  assert.equal(shouldAnalyzeMemoryJournalTurn({ userText: '记忆同步有延迟' }), true);
});

test('short continuation cues only trigger when there is open context to resume', () => {
  const userText = '宝宝你继续';
  assert.equal(isMemoryContinuationCue(userText), true);
  assert.equal(shouldAnalyzeMemoryJournalContinuation({
    userText,
    existingContext: { openMarks: [], summary: { open_threads: [] } },
  }), false);
  assert.equal(shouldAnalyzeMemoryJournalContinuation({
    userText,
    existingContext: { openMarks: [{ id: 'open-1' }], summary: { open_threads: [] } },
  }), true);
});

test('daily-summary open threads authorize a short continuation update', () => {
  assert.equal(shouldAnalyzeMemoryJournalContinuation({
    userText: '那就接着做',
    existingContext: { openMarks: [], summary: { open_threads: ['正在修复 OurHome 的临时记忆'] } },
  }), true);
});
