const test = require('node:test');
const assert = require('node:assert/strict');
const { TIMELINE_MARKER, TIMELINE_GUARD, relabelCheckpointMemory } = require('../theaterContinuityGuardPatch');

test('Timeline v2 distinguishes the latest checkpoint from the real present', () => {
  const text = relabelCheckpointMemory('【当前场景状态·时间线最前沿】\n昨晚还在客栈\n【未完成线索】\n明天去城外');
  assert.match(text, /最近一次记忆检查点·可能略旧/);
  assert.match(text, /记忆检查点中的未完成线索·以近期记录校验/);
});

test('Timeline v2 explicitly anchors past, present and future', () => {
  assert.match(TIMELINE_GUARD, new RegExp(TIMELINE_MARKER));
  assert.match(TIMELINE_GUARD, /过去 → 现在 → 未来/);
  assert.match(TIMELINE_GUARD, /当前时间只认最近证据/);
  assert.match(TIMELINE_GUARD, /跨时间推进/);
  assert.match(TIMELINE_GUARD, /事件完成性/);
  assert.match(TIMELINE_GUARD, /避免伪造跳时/);
});
