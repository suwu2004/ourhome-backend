const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isThinkingDecisionRequest,
  sanitizeChatSystem,
  prepareMainChatRequest,
} = require('../thinkingTransportPatch');

test('旧的可见思考提示会从主 Chat system 中移除', () => {
  const system = '基础人设\n【回复长度】自然回复\n【OurHome 房间与入口认知（事实规则）】在家\n\n【可见的内心独白】\n请用 <thinking> 模拟思考。';
  const cleaned = sanitizeChatSystem(system);
  assert.match(cleaned, /基础人设/);
  assert.doesNotMatch(cleaned, /可见的内心独白|<thinking>/);
});

test('已经由原生模型路径产生的 thinking 参数不会再被误删', () => {
  const thinking = { type: 'enabled', budget_tokens: 3000 };
  const prepared = prepareMainChatRequest(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-thinking',
      thinking,
      temperature: 1,
      system: '基础人设\n【可见的内心独白】\n不要保留这段模拟协议。',
    },
    { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
  );

  assert.deepEqual(prepared.body.thinking, thinking);
  assert.equal(prepared.body.temperature, 1);
  assert.doesNotMatch(prepared.body.system, /可见的内心独白/);
  assert.equal(prepared.headers.get('anthropic-beta'), 'interleaved-thinking-2025-05-14');
});

test('relay 可保留原生 thinking body 但不会携带 Anthropic 专属 beta header', () => {
  const thinking = { type: 'enabled', budget_tokens: 3000 };
  const prepared = prepareMainChatRequest(
    'https://relay.example.com/v1/messages',
    { model: 'relay-thinking-model', thinking, system: '正常 system' },
    { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
  );

  assert.deepEqual(prepared.body.thinking, thinking);
  assert.equal(prepared.headers.has('anthropic-beta'), false);
});

test('旧的要不要想判断仍由本地拦截条件识别', () => {
  assert.equal(isThinkingDecisionRequest('https://relay.example.com/v1/messages', {
    max_tokens: 8,
    messages: [{ role: 'user', content: '只回答一个词：想 或者 不想' }],
  }), true);
});
