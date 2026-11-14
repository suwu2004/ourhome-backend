'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  inferPurpose,
  pickBudgetModel,
  pickBudgetModels,
  isRetryableBudgetModelFailure,
  requestWithModelFallback,
  isTheaterMemoryRequest,
  isTheaterRequest,
  preservesRequestedModel,
  shouldPreserveRequestedModelForCall,
} = require('../nonChatBudgetPatch');

const source = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '..', 'nonChatBudgetPatch.js'), 'utf8');
const sharedChatPersona = [
  '【回复长度】普通聊天的回复长度规则',
  '【OurHome 房间与入口认知（事实规则）】聊天上下文说明',
];

test('foreground Chat pricing requires an explicit purpose, not inherited system-prompt markers', () => {
  const body = { system: sharedChatPersona.join('\n'), messages: [{ role: 'user', content: '早上好' }] };
  assert.equal(shouldPreserveRequestedModelForCall('chat', body), true);
  assert.equal(shouldPreserveRequestedModelForCall('non-chat-budget', body), false);
  assert.doesNotMatch(source, /isMainChatRequest\(url, body\)/);
});

test('background diary and mood tasks remain cheap even when they reuse the Chat persona', () => {
  const body = {
    system: [...sharedChatPersona, '【心情日历边界】后台记录任务'].join('\n'),
    messages: [{ role: 'user', content: '给今天留一段心情' }],
  };
  assert.equal(shouldPreserveRequestedModelForCall('daily-mood', body), false);
  assert.equal(shouldPreserveRequestedModelForCall('home-memo', body), false);
  assert.equal(shouldPreserveRequestedModelForCall('memory-dream-review', body), false);
});

test('heartbeat remains cheap even when the reused persona mentions Toy Bear and Theater', () => {
  const body = {
    system: [...sharedChatPersona, '【小剧场】互动写作引擎', '【玩具熊】互动模式'].join('\\n'),
    messages: [{ role: 'user', content: '这不是叶檀刚发来的消息，而是自动心跳提醒你' }],
  };
  assert.equal(inferPurpose(body), 'automation-heartbeat');
  assert.equal(shouldPreserveRequestedModelForCall('automation-heartbeat', body), false);
});

test('automatic session summaries have a distinct cheap-background task purpose', () => {
  const body = {
    system: '请根据旧聊天内容生成窗口简介。',
    messages: [{ role: 'user', content: '增量整理归档消息并更新窗口简介。' }],
  };
  assert.equal(inferPurpose(body), 'session-summary-auto');
  assert.equal(shouldPreserveRequestedModelForCall('session-summary-auto', body), false);
});

test('Happiness Diary and final learning synthesis retain the intended Chat model', () => {
  const body = { system: sharedChatPersona.join('\n'), messages: [{ role: 'user', content: '写日记' }] };
  assert.equal(preservesRequestedModel('happiness-diary'), true);
  assert.equal(preservesRequestedModel('luze-learning-synthesis'), true);
  assert.equal(shouldPreserveRequestedModelForCall('happiness-diary', body), true);
  assert.equal(shouldPreserveRequestedModelForCall('luze-learning-synthesis', body), true);
  assert.equal(shouldPreserveRequestedModelForCall('luze-learning-plan', body), false);
});

test('interactive Theater stays user-selected while Theater memory is cheap background work', () => {
  const interactive = {
    system: '你是 OurHome 的“小剧场”互动写作引擎',
    messages: [{ role: 'user', content: '【剧本名】\n高木彦' }],
  };
  const memory = {
    system: '你是“角色与剧情记忆整理器”。只整理资料，不扮演角色。',
    messages: [{ role: 'user', content: '请更新这本互动剧场的持续记忆。' }],
  };
  assert.equal(isTheaterRequest(interactive), true);
  assert.equal(isTheaterMemoryRequest(interactive), false);
  assert.equal(isTheaterMemoryRequest(memory), true);
  assert.equal(isTheaterRequest(memory), false);
  assert.equal(inferPurpose(memory), 'theater-memory');
  assert.equal(shouldPreserveRequestedModelForCall('theater-memory', memory), false);
  assert.equal(shouldPreserveRequestedModelForCall('theater', interactive), true);
  assert.match(source, /Theater memory is deliberately/);
});

test('Toy Bear is inferred as an interactive purpose without overriding explicit background purposes', () => {
  const body = { system: '【玩具熊】互动模式', messages: [] };
  assert.equal(inferPurpose(body), 'toybox');
  assert.equal(shouldPreserveRequestedModelForCall('toybox', body), true);
  assert.equal(shouldPreserveRequestedModelForCall('automation-heartbeat', body), false);
});

test('AgentMail inbox reading is excluded from the foreground Chat pricing exemption', () => {
  const body = {
    system: sharedChatPersona.join('\n'),
    tools: [{ name: 'check_agentmail_inbox', description: '读取收件箱' }],
    messages: [{ role: 'user', content: '查看收件箱里的邮件' }],
  };
  assert.equal(shouldPreserveRequestedModelForCall('chat', body), false);
});

test('budget selector retains its low-cost and vision safety filters', () => {
  assert.match(source, /explicitPriceHint/);
  assert.match(source, /flash\[-_ \]\?lite\|nano/);
  assert.match(source, /haiku\|mini\|lite\|small/);
  assert.match(source, /opus\|pro\|max/);
  assert.match(source, /thinking\|reasoning/);
  assert.match(source, /!vision \|\| isLikelyVisionModel\(model\)/);
});

test('unavailable low-cost models are blocked instead of falling back to a costly Chat model', () => {
  assert.match(source, /Never silently fall back to an expensive active Chat model/);
  assert.match(source, /ourhome_budget_model_unavailable/);
  assert.match(source, /blocked paid non-chat call/);
});

test('background selector prefers every Gemini 3.8 Flash alias regardless of provider prefix', () => {
  assert.equal(pickBudgetModel([
    'claude-haiku-4-5',
    'gemini-3.1-flash-lite',
    'gemini-3.1-flash',
    'openrouter/google/gemini-3.8-flash-preview',
    'vendor-prefix/gemini-3.8-flash',
    'claude-opus-4-6',
  ]), 'openrouter/google/gemini-3.8-flash-preview');
  assert.equal(pickBudgetModel([
    'gemini-3.1-flash-lite',
    'vendor-prefix/gemini-3.8-flash',
  ]), 'vendor-prefix/gemini-3.8-flash');
  assert.equal(pickBudgetModel(['claude-haiku-4-5', 'gemini-3.1-pro-preview']), '');
});


test('budget selector keeps an ordered list of safe Flash fallbacks', () => {
  assert.deepEqual(pickBudgetModels([
    'claude-haiku-4-5',
    'gemini-3.1-flash-lite',
    'gemini-3.1-flash',
    'openrouter/google/gemini-3.8-flash-preview',
    'vendor-prefix/gemini-3.8-flash',
    'claude-opus-4-6',
  ]), [
    'openrouter/google/gemini-3.8-flash-preview',
    'vendor-prefix/gemini-3.8-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.1-flash',
  ]);
  assert.deepEqual(pickBudgetModels([
    'gemini-3.1-flash-lite',
    'gemini-3.1-flash',
    'gemini-3.1-pro-vision',
  ], { vision: true }), ['gemini-3.1-flash-lite', 'gemini-3.1-flash']);
});

test('model route failures trigger fallback without treating unrelated permission errors as model failures', () => {
  assert.equal(isRetryableBudgetModelFailure(503, '请求模型无可用账号'), true);
  assert.equal(isRetryableBudgetModelFailure(429, ''), true);
  assert.equal(isRetryableBudgetModelFailure(403, 'risk-control blocked this model'), true);
  assert.equal(isRetryableBudgetModelFailure(404, 'model_not_found'), true);
  assert.equal(isRetryableBudgetModelFailure(403, 'invalid API key'), false);
  assert.equal(isRetryableBudgetModelFailure(400, 'temperature is out of range'), false);
});

test('budget requests retry a failed low-cost route on the next Flash candidate', async () => {
  const attempted = [];
  const retried = [];
  const response = status => ({
    status,
    ok: status >= 200 && status < 300,
    clone() { return { text: async () => '' }; },
  });
  const outcome = await requestWithModelFallback(
    ['[A]gemini-3.8-flash', '[B]gemini-3.8-flash', 'gemini-3.1-flash-lite'],
    async model => {
      attempted.push(model);
      return response(model.startsWith('[A]') ? 503 : 200);
    },
    {
      maxAttempts: 3,
      shouldRetry: async result => isRetryableBudgetModelFailure(result.status) ? `HTTP ${result.status}` : '',
      onRetry: event => retried.push(event),
    },
  );
  assert.deepEqual(attempted, ['[A]gemini-3.8-flash', '[B]gemini-3.8-flash']);
  assert.equal(retried.length, 1);
  assert.equal(retried[0].nextModel, '[B]gemini-3.8-flash');
  assert.equal(outcome.model, '[B]gemini-3.8-flash');
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.response.ok, true);
});

test('budget fallback does not fan out on ordinary malformed-request responses', async () => {
  const attempted = [];
  const response = { status: 400, ok: false, clone() { return { text: async () => 'invalid max_tokens' }; } };
  const outcome = await requestWithModelFallback(
    ['gemini-3.8-flash', 'gemini-3.1-flash-lite'],
    async model => { attempted.push(model); return response; },
  );
  assert.deepEqual(attempted, ['gemini-3.8-flash']);
  assert.equal(outcome.response, response);
  assert.equal(outcome.model, 'gemini-3.8-flash');
});


test('the final failed low-cost route is also reported for cooldown', async () => {
  const events = [];
  const response = { status: 503, ok: false };
  const outcome = await requestWithModelFallback(
    ['gemini-3.8-flash'],
    async () => response,
    {
      shouldRetry: async result => isRetryableBudgetModelFailure(result.status) ? 'HTTP 503' : '',
      onRetry: event => events.push(event),
    },
  );
  assert.equal(outcome.response, response);
  assert.equal(events.length, 1);
  assert.equal(events[0].nextModel, null);
  assert.equal(events[0].model, 'gemini-3.8-flash');
});

test('the final network failure is reported for cooldown before it is rethrown', async () => {
  const events = [];
  await assert.rejects(
    requestWithModelFallback(
      ['gemini-3.8-flash'],
      async () => { throw new Error('upstream timeout'); },
      { onRetry: event => events.push(event) },
    ),
    /upstream timeout/,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].nextModel, null);
  assert.equal(events[0].reason, 'upstream timeout');
});

test('model-list failure fallback cannot reintroduce a non-Flash selected model', () => {
  assert.match(source, /selected && isFlashModel\(selected\)/);
});

test('vision background selector only returns vision-capable Flash models', () => {
  assert.equal(pickBudgetModel([
    'gemini-3.1-flash-lite',
    'gemini-3.1-flash',
    'gemini-3.1-pro-vision',
  ], { vision: true }), 'gemini-3.1-flash-lite');
});

test('rewritten non-Chat calls carry the effective task purpose into usage logs', () => {
  assert.match(source, /headers\.set\('X-OurHome-Call-Purpose', effectivePurpose\)/);
});
