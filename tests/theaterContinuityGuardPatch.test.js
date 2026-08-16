const test = require('node:test');
const assert = require('node:assert/strict');

const support = require('../theaterMemorySupport');
const {
  CONTINUITY_MARKER,
  relabelCheckpointMemory,
  injectContinuityGuard,
} = require('../theaterContinuityGuardPatch');

test('旧 current_state 被明确标成记忆检查点而不是实时前沿', () => {
  const text = relabelCheckpointMemory('【当前场景状态·时间线最前沿】\n昨夜在房内。\n【未完成线索】\n明日下山。');
  assert.match(text, /【最近一次记忆检查点·可能略旧】/);
  assert.match(text, /【记忆检查点中的未完成线索·以近期记录校验】/);
  assert.doesNotMatch(text, /【当前场景状态·时间线最前沿】/);
});

test('剧场提示把最近互动设为最高实时前沿并禁止回放已完成剧情', () => {
  const body = {
    messages: [{
      role: 'user',
      content: '【剧本名】\n测试\n\n【较早剧情提要】\n昨夜已经睡下。\n\n【最近互动记录】\n次日已经下山并返回。',
    }],
  };
  const memory = support.normalizeTheaterMemory({
    character_anchor: '角色稳定。',
    character_memory: '记得重要事实。',
    plot_facts: ['已经下山买过东西。'],
    current_state: '昨夜仍在床上。',
    open_threads: ['明日是否下山。'],
  });
  const injected = injectContinuityGuard(body, memory);
  const prompt = injected.messages[0].content;
  assert.match(prompt, new RegExp(CONTINUITY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompt, /最近互动记录.*实时的时间线最前沿/s);
  assert.match(prompt, /禁止把已经完成的.*情节重新演一遍/s);
  assert.match(prompt, /最近一次记忆检查点·可能略旧/);
  assert.match(prompt, /记忆检查点中的未完成线索·以近期记录校验/);
  assert.ok(prompt.indexOf(CONTINUITY_MARKER) < prompt.indexOf('【较早剧情提要】'));
});

test('连续性防回放指令重复注入时保持单份', () => {
  const body = {
    messages: [{ role: 'user', content: '【最近互动记录】\n现在在院中。' }],
  };
  const memory = support.normalizeTheaterMemory({
    character_anchor: '角色稳定。',
    character_memory: '记得重要事实。',
    current_state: '旧房间。',
  });
  const once = injectContinuityGuard(body, memory);
  const twice = injectContinuityGuard(once, memory);
  const count = twice.messages[0].content.split(CONTINUITY_MARKER).length - 1;
  assert.equal(count, 1);
});
