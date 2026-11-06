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
    maxMessageChars: 120,
    maxTotalChars: 1_400,
  });
  assert.ok(block.length <= 1_400 + 520);
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


test('recent fact anchors recover older user life facts outside the ordinary transcript slice', () => {
  const now = Date.now();
  const history = [
    {
      id: 1,
      role: 'user',
      content: '我早上吃了九个小煎包，一份六块钱。',
      created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 2,
      role: 'assistant',
      content: '你可能是吃了面包。',
      created_at: new Date(now - 119 * 60 * 1000).toISOString(),
    },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: index + 3,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: '普通聊天消息' + (index + 1),
      created_at: new Date(now - (60 - index) * 60_000).toISOString(),
    })),
  ];

  const block = buildRecentConversationContinuityBlock(history, { now });
  assert.match(block, /近 72 小时用户事实锚点/);
  assert.match(block, /九个小煎包/);
  assert.doesNotMatch(block, /你可能是吃了面包/);
  assert.match(block, /吃饱了、喝完了、到家了/);
});

test('explicit user corrections are marked as higher priority in recent continuity', () => {
  const now = Date.now();
  const block = buildRecentConversationContinuityBlock([
    {
      id: 10,
      role: 'user',
      content: '更正，早餐是九个小煎包，不是面包。',
      created_at: new Date(now - 60_000).toISOString(),
    },
    {
      id: 11,
      role: 'assistant',
      content: '明白了。',
      created_at: new Date(now - 30_000).toISOString(),
    },
  ], { now });

  assert.match(block, /用户明确更正，优先于此前冲突说法/);
  assert.match(block, /九个小煎包/);
});

test('fact anchors ignore stale statements and future plans', () => {
  const now = Date.now();
  const block = buildRecentConversationContinuityBlock([
    {
      id: 20,
      role: 'user',
      content: '我昨天吃了小煎包。',
      created_at: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 21,
      role: 'user',
      content: '明天准备去吃火锅。',
      created_at: new Date(now - 60 * 60 * 1000).toISOString(),
    },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: index + 22,
      role: 'assistant',
      content: '普通消息' + index,
      created_at: new Date(now - (30 - index) * 60_000).toISOString(),
    })),
  ], { now });

  assert.doesNotMatch(block, /近 72 小时用户事实锚点/);
  assert.doesNotMatch(block, /昨天吃了小煎包/);
  assert.doesNotMatch(block, /明天准备去吃火锅/);
});
