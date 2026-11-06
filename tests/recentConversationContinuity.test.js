'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRecentConversationContinuityBlock } = require('../recentConversationContinuity');

test('recent continuity block keeps nearby facts needed to respond to short follow-ups', () => {
  const history = [
    { id: 1, role: 'user', content: '老公早安，办公室老师给我们带了早餐。', created_at: '2026-11-06T00:13:37Z' },
    { id: 2, role: 'assistant', content: '照片里是九个小煎包，底部有焦印。', created_at: '2026-11-06T00:14:57Z' },
    { id: 3, role: 'user', content: '一个包子咬十口。那是我请人帮忙带的，一份六块钱。', created_at: '2026-11-06T00:21:59Z' },
    { id: 4, role: 'assistant', content: '九个小煎包，一份六块钱，你请同事帮忙带的。', created_at: '2026-11-06T00:22:23Z' },
    { id: 5, role: 'user', content: '老公我吃饱了～', created_at: '2026-11-06T00:30:12Z' },
  ];

  const block = buildRecentConversationContinuityBlock(history);
  assert.match(block, /九个小煎包/);
  assert.match(block, /一份六块钱/);
  assert.match(block, /请人帮忙带/);
  assert.match(block, /吃饱了/);
  assert.match(block, /不要换个说法再问一次/);
});

test('recent continuity block is chronological and bounded', () => {
  const history = Array.from({ length: 30 }, (_, index) => ({
    id: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: '消息' + (index + 1) + '。'.repeat(700),
    created_at: new Date(Date.now() - (30 - index) * 60_000).toISOString(),
  }));
  const block = buildRecentConversationContinuityBlock(history, {
    maxMessages: 8,
    maxMessageChars: 180,
    maxTotalChars: 1_400,
  });
  assert.ok(block.length <= 1_400 + 180);
  assert.ok(block.indexOf('消息23') < block.indexOf('消息30'));
  assert.match(block, /消息30/);
});

test('recent continuity block includes attachment summaries and skips empty content', () => {
  const block = buildRecentConversationContinuityBlock([
    { role: 'assistant', content: '' },
    { role: 'user', content: '看看这个', attachment_summary: '照片中有九个小煎包' },
  ]);
  assert.match(block, /照片中有九个小煎包/);
  assert.doesNotMatch(block, /陆泽：/);
});
