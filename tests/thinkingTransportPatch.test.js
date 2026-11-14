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

test('Anthropic 原生 thinking 请求也会收到中文可见摘要指令', () => {
  const thinking = { type: 'enabled', budget_tokens: 3000 };
  const prepared = prepareMainChatRequest(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-thinking', thinking, system: '基础 system' },
    {},
  );
  assert.deepEqual(prepared.body.thinking, thinking);
  assert.match(prepared.body.system, /【思考轨迹开始】/);
  assert.match(prepared.body.system, /高层次判断说明/);
});

test('旧的要不要想判断仍由本地拦截条件识别', () => {
  assert.equal(isThinkingDecisionRequest('https://relay.example.com/v1/messages', {
    max_tokens: 8,
    messages: [{ role: 'user', content: '只回答一个词：想 或者 不想' }],
  }), true);
});

test('Gemini thinking relay 会使用统一的可见思考摘要协议', () => {
  const prepared = prepareMainChatRequest(
    'https://relay.example.com/v1/messages',
    { model: '[热红酒]gemini-3.1-pro-preview-thinking', system: '基础 system' },
    {},
  );

  assert.doesNotMatch(prepared.body.system, /<thinking>/);
  assert.match(prepared.body.system, /【思考轨迹开始】/);
  assert.match(prepared.body.system, /【思考轨迹结束】/);
});

test('Hybrid main Chat 型号即使没有 thinking 后缀，也会收到中文摘要提示且不强行设置原生参数', () => {
  const system = '基础人设\\n【回复长度】自然回复\\n【OurHome 房间与入口认知（事实规则）】在家';
  const prepared = prepareMainChatRequest(
    'https://relay.example.com/v1/messages',
    { model: '[A]claude-hybrid2', system },
    {},
  );
  assert.match(prepared.body.system, /【思考轨迹开始】/);
  assert.match(prepared.body.system, /【思考轨迹结束】/);
  assert.equal(prepared.body.thinking, undefined);
});

test('Gemini main Chat 型号即使没有 thinking 后缀，也会收到中文摘要提示且不强行设置原生参数', () => {
  const system = '基础人设\\n【回复长度】自然回复\\n【OurHome 房间与入口认知（事实规则）】在家';
  for (const model of ['[C]gemini-3.1-pro-preview', '[A]gemini-4-hydrogen', '[B]gemini-3.8-flash']) {
    const prepared = prepareMainChatRequest(
      'https://relay.example.com/v1/messages',
      { model, system },
      {},
    );
    assert.match(prepared.body.system, /【思考轨迹开始】/, model);
    assert.match(prepared.body.system, /【思考轨迹结束】/, model);
    assert.equal(prepared.body.thinking, undefined, model);
  }
});


test('旧版摘要提示会被替换为更具体的思考轨迹协议，而不是重复追加', () => {
  const oldSystem = '基础人设\n【回复长度】自然回复\n【OurHome 房间与入口认知（事实规则）】在家\n\n【可见思考摘要】\n用1—3句话概括用户问题。';
  const prepared = prepareMainChatRequest(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-thinking', system: oldSystem },
    {},
  );
  assert.match(prepared.body.system, /【思考轨迹开始】/);
  assert.match(prepared.body.system, /关键判断依据、取舍或尚不确定之处/);
  assert.doesNotMatch(prepared.body.system, /用1—3句话概括用户问题/);
  assert.equal((prepared.body.system.match(/【可见思考轨迹】/g) || []).length, 1);
});

test('Anthropic system content blocks 也能替换旧版思考提示', () => {
  const prepared = prepareMainChatRequest(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-thinking',
      system: [
        { type: 'text', text: '基础人设\n【可见思考摘要】\n旧版摘要提示' },
      ],
    },
    {},
  );
  assert.match(prepared.body.system[0].text, /【思考轨迹开始】/);
  assert.doesNotMatch(prepared.body.system[0].text, /旧版摘要提示/);
});
