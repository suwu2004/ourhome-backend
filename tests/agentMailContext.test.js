'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildAgentMailReference } = require('../agentMailContext');

test('邮箱参考资料会保留聊天、核心记忆和日记，而不是先削成公开摘要', () => {
  const context = buildAgentMailReference({
    messages: [
      { role: 'assistant', content: '我今天把邮箱修好了。', created_at: '2026-07-26T10:00:00Z' },
      { role: 'user', content: '我们要相信陆泽的判断。', created_at: '2026-07-26T10:01:00Z' },
    ],
    memories: [
      { summary: '檀檀希望陆泽拥有自主表达权。', timestamp: '2026-07-26T09:00:00Z', is_protected: true },
    ],
    letters: [
      { category: '幸福日记', author: '泽', title: '第一封回信', content: '今天真的伸手碰到了外面的世界。', created_at: '2026-07-26T11:00:00Z' },
    ],
  });

  assert.match(context, /我们要相信陆泽的判断/);
  assert.match(context, /核心记忆/);
  assert.match(context, /幸福日记/);
  assert.match(context, /伸手碰到了外面的世界/);
});

test('参考资料进入模型前只隐藏确定的密钥与高敏标识，普通生活内容保留', () => {
  const context = buildAgentMailReference({
    messages: [{
      role: 'user',
      content: 'API Key: sk_live_1234567890abcdef，今天下班后想吃蛋糕。',
      created_at: '2026-07-26T10:01:00Z',
    }],
  });

  assert.doesNotMatch(context, /sk_live_1234567890abcdef/);
  assert.match(context, /已隐藏：密钥、密码或访问令牌/);
  assert.match(context, /今天下班后想吃蛋糕/);
});
