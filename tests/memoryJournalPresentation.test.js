'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractExistingSummary,
  isInternalTurnSummary,
  chooseDailySummary,
  patchJournalResult,
} = require('../memoryJournalPresentationPatch');

function requestBody(existing) {
  return {
    model: 'local-test',
    messages: [{
      role: 'user',
      content: `请为 OurHome 的记忆日志分析刚刚这一轮聊天。\n【今天已有摘要】\n${existing}\n【未收尾话题】\n无\n【刚刚这一轮】\n叶檀：新的话题\n陆泽：新的回复\n请只输出 JSON`,
    }],
  };
}

test('extractExistingSummary reads only the curated day summary', () => {
  assert.equal(extractExistingSummary(requestBody('今天原本是一段干净的小结。')), '今天原本是一段干净的小结。');
  assert.equal(extractExistingSummary(requestBody('无')), '');
});

test('patchJournalResult keeps metadata but prevents per-turn text from replacing display summary', () => {
  const result = {
    mark: { summary: '内部接续', should_continue: true },
    daily_summary: {
      summary: '本轮：不应该显示在幸福日记里',
      highlights: ['重点'],
      open_threads: ['待续'],
    },
  };
  const next = patchJournalResult(result, '今天原本是一段干净的小结。');
  assert.equal(next.daily_summary.summary, '今天原本是一段干净的小结。');
  assert.deepEqual(next.daily_summary.highlights, ['重点']);
  assert.deepEqual(next.daily_summary.open_threads, ['待续']);
  assert.equal(next.mark.summary, '内部接续');
});

test('a day without curated summary stays blank instead of exposing 本轮 logs', () => {
  const next = patchJournalResult({ daily_summary: { summary: '本轮：内部记录' } }, '');
  assert.equal(next.daily_summary.summary, '');
});

test('a valid cumulative daily update is not overwritten by the previous summary', () => {
  const next = patchJournalResult({
    daily_summary: {
      summary: '今天上午聊了课程安排，下午继续推进 OurHome 的记忆修复，尚有上下文回归测试待完成。',
    },
  }, '昨天的旧摘要。');
  assert.match(next.daily_summary.summary, /今天上午聊了课程安排/);
  assert.match(next.daily_summary.summary, /上下文回归测试/);
});

test('an internal per-turn diagnostic preserves the last curated summary', () => {
  assert.equal(isInternalTurnSummary('本轮：讨论了一个临时问题。'), true);
  assert.equal(isInternalTurnSummary('今天的重点是课程安排和 OurHome 项目进展。'), false);
  assert.equal(chooseDailySummary('本轮：不应显示的日志', '已有的干净日摘要。'), '已有的干净日摘要。');
  assert.equal(chooseDailySummary('', '已有的干净日摘要。'), '已有的干净日摘要。');
});
