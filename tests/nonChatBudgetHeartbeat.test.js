const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'nonChatBudgetPatch.js'), 'utf8');
const {
  AUTOMATION_HEARTBEAT_PURPOSE,
  inferPurpose,
  isHeartbeatPurpose,
  pickBudgetModel,
  shouldPreserveRequestedModelForCall,
} = require('../nonChatBudgetPatch');

test('主动心跳会被识别成后台用途而不是普通 Chat', () => {
  const body = {
    model: 'claude-opus-4-6',
    system: '【回复长度】\n【OurHome 房间与入口认知（事实规则）】',
    messages: [{
      role: 'user',
      content: '这不是叶檀刚发来的消息，而是自动心跳提醒你：如果确实过了一段时间没说话，你可以主动敲门。',
    }],
  };
  assert.equal(inferPurpose(body), AUTOMATION_HEARTBEAT_PURPOSE);
  assert.equal(isHeartbeatPurpose(inferPurpose(body)), true);
  assert.equal(shouldPreserveRequestedModelForCall(AUTOMATION_HEARTBEAT_PURPOSE, body), false);
});

test('主动心跳沿用现有最低成本模型选择器', () => {
  assert.equal(
    pickBudgetModel(['claude-opus-4-6', 'claude-sonnet-4-6', 'gemini-3-flash']),
    'gemini-3-flash',
  );
});

test('后台调用按显式 purpose 路由，且 5xx 心跳进入本地冷却', () => {
  assert.match(source, /shouldPreserveRequestedModelForCall\(effectivePurpose, body\)/);
  assert.match(source, /heartbeatBackoffUntil > Date\.now\(\)/);
  assert.match(source, /response\.status >= 500/);
  assert.match(source, /HEARTBEAT_BACKOFF_MS = 60 \* 60 \* 1000/);
  assert.match(source, /chat-writing-v6-cheap-heartbeat-theater-memory/);
});
