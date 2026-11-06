'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileChatContext, SOURCE_PRIORITY } = require('../chatContextCompiler');

test('required current context and action boundary survive a zero optional budget', () => {
  const result = compileChatContext({
    basePrompt: '你是陆泽。',
    timeContext: '当前时间信息。',
    layers: [
      { id: 'daily', label: '今日摘要', source: 'daily_summaries', content: '今天去了学校。', priority: SOURCE_PRIORITY.dailyContext },
      { id: 'recent', label: '最近原始对话', source: 'messages', content: '叶檀：九个小煎包，一份六块钱。', priority: SOURCE_PRIORITY.recentConversation, required: true },
      { id: 'rules', label: '共享规则', source: 'chat_rules', content: '不要重复追问。', priority: SOURCE_PRIORITY.chatRules, required: true, kind: 'instruction' },
    ],
    actionBoundary: '不得修改设置。',
    optionalBudget: 0,
  });

  assert.match(result.prompt, /你是陆泽/);
  assert.match(result.prompt, /九个小煎包/);
  assert.match(result.prompt, /不要重复追问/);
  assert.match(result.prompt, /不得修改设置/);
  assert.deepEqual(result.omitted.map(item => item.id), ['daily']);
});

test('higher-priority corrections are selected first and rendered after older summaries', () => {
  const result = compileChatContext({
    basePrompt: 'base',
    layers: [
      { id: 'old', label: '旧窗口简介', source: 'session_summaries', content: '早餐未知。', priority: 50, updatedAt: '2026-11-05' },
      { id: 'daily', label: '今日摘要', source: 'daily_summaries', content: '早餐是面包。', priority: 60, updatedAt: '2026-11-06' },
      { id: 'correction', label: '最近纠正', source: 'messages', content: '用户更正：早餐是九个小煎包。', priority: 100, required: true, updatedAt: '2026-11-06 08:22' },
    ],
  });

  assert.ok(result.prompt.indexOf('旧窗口简介') < result.prompt.indexOf('今日摘要'));
  assert.ok(result.prompt.indexOf('今日摘要') < result.prompt.indexOf('最近纠正'));
  assert.match(result.prompt, /用户明确更正优先于助手猜测/);
});

test('exact duplicate blocks are included once with the strongest source', () => {
  const result = compileChatContext({
    layers: [
      { id: 'weak', label: '窗口简介', source: 'summary', content: '用户喜欢雨天。', priority: 40 },
      { id: 'strong', label: '核心记忆', source: 'memories', content: ' 用户喜欢雨天。 ', priority: 80, updatedAt: '2026-11-06' },
    ],
  });

  assert.equal((result.prompt.match(/用户喜欢雨天/g) || []).length, 1);
  assert.deepEqual(result.duplicateIds, ['strong']);
  assert.match(result.prompt, /来源：memories/);
});

test('optional budget omits lower-priority background without clipping selected facts', () => {
  const result = compileChatContext({
    layers: [
      { id: 'old', label: '旧信件', source: 'letters', content: '旧内容'.repeat(50), priority: 10 },
      { id: 'recent', label: '阶段记忆', source: 'memory_marks', content: '最新进展'.repeat(10), priority: 70 },
    ],
    optionalBudget: 180,
  });

  assert.ok(result.included.some(item => item.id === 'recent'));
  assert.ok(result.omitted.some(item => item.id === 'old'));
  assert.match(result.prompt, /最新进展/);
});

test('layer metadata preserves provenance, update time, and coverage checkpoint', () => {
  const result = compileChatContext({
    layers: [{
      id: 'session',
      label: '窗口简介',
      source: 'session_summaries',
      updatedAt: '2026-11-06T08:30:00+08:00',
      coverage: '截至消息 19501',
      content: '早餐信息已确认。',
      priority: 50,
      required: true,
    }],
  });

  assert.match(result.prompt, /来源：session_summaries/);
  assert.match(result.prompt, /更新时间：2026-11-06T08:30:00+08:00/);
  assert.match(result.prompt, /覆盖：截至消息 19501/);
});
