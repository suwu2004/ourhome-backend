'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { AgentMailError, createAgentMailClient } = require('../agentMail');
const {
  createAgentMailService,
  normalizeAgentMailMessage,
  validateRecipients,
} = require('../agentMailService');
const {
  createBoundReplyHandler,
  createBoundReplyTool,
  isLegacyReplyBindingFailure,
} = require('../agentMailDecision');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function createMemoryAuditStore() {
  const rows = [];
  let nextId = 1;
  return {
    rows,
    async insert(activity, { ignoreDuplicate = false } = {}) {
      if (activity.event_key && rows.some(row => row.event_key === activity.event_key)) {
        if (ignoreDuplicate) return null;
        const error = new Error('duplicate key');
        error.code = '23505';
        throw error;
      }
      const now = new Date().toISOString();
      const row = { id: `activity-${nextId++}`, created_at: now, updated_at: now, ...activity };
      rows.push(row);
      return row;
    },
    async update(id, updates) {
      const row = rows.find(item => item.id === id);
      Object.assign(row, updates, { updated_at: new Date().toISOString() });
      return row;
    },
    async list({ limit = 80 } = {}) {
      return [...rows].reverse().slice(0, limit);
    },
  };
}

function createRuntimeConfig(overrides = {}) {
  const publicConnection = {
    id: 'mail-connection',
    kind: 'agentmail',
    name: '陆泽邮箱',
    url: 'https://api.agentmail.to/v0',
    enabled: true,
    has_secret: true,
    has_webhook_secret: true,
    config: {
      inbox_id: 'luzeeagent-4803@agentmail.to',
      email: 'luzeeagent-4803@agentmail.to',
      autonomous: true,
    },
  };
  return {
    listConnections: async () => [publicConnection],
    getConnectionRuntime: async () => ({ ...publicConnection, secret: 'agentmail-key' }),
    saveConnection: async input => ({ ...publicConnection, ...input, id: publicConnection.id }),
    deleteConnection: async () => {},
    getAgentMailWebhookSecret: async () => overrides.webhookSecret || 'whsec_test',
    saveAgentMailWebhookSecret: async () => 'secret-id',
    ...overrides,
  };
}

test('AgentMail 客户端使用 Bearer 密钥并限制列表数量', async () => {
  const calls = [];
  const client = createAgentMailClient({
    apiKey: 'secret-key',
    inboxId: 'luzeeagent-4803@agentmail.to',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ messages: [] });
    },
  });

  await client.listMessages({ limit: 999, subject: 'OurHome' });
  await client.sendMessage({ to: ['friend@example.com'], subject: 'hello', text: 'hi' });

  assert.match(calls[0].url, /\/inboxes\/luzeeagent-4803%40agentmail\.to\/messages/);
  assert.match(calls[0].url, /limit=100/);
  assert.match(calls[0].url, /subject=OurHome/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-key');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    to: ['friend@example.com'],
    subject: 'hello',
    text: 'hi',
  });
});

test('AgentMail 客户端把上游错误转换成不含密钥的结构化错误', async () => {
  const client = createAgentMailClient({
    apiKey: 'never-show-this',
    inboxId: 'luzeeagent-4803@agentmail.to',
    fetchImpl: async () => jsonResponse({ error: { message: 'Unauthorized', code: 'bad_key' } }, 401),
  });

  await assert.rejects(
    client.getInbox(),
    error => error instanceof AgentMailError
      && error.status === 401
      && error.code === 'bad_key'
      && !error.message.includes('never-show-this'),
  );
});

test('邮件标准化会判断收发方向并只保留安全的附件元数据', () => {
  const normalized = normalizeAgentMailMessage({
    id: 'message-1',
    thread_id: 'thread-1',
    from: { name: '朋友', email: 'friend@example.com' },
    to: ['luzeeagent-4803@agentmail.to'],
    subject: '问候',
    extracted_text: '今天好吗？',
    attachments: [{ id: 'attachment-1', filename: 'hello.pdf', content_type: 'application/pdf', content: 'do-not-copy' }],
  }, 'luzeeagent-4803@agentmail.to');

  assert.equal(normalized.direction, 'inbound');
  assert.equal(normalized.from, '朋友 <friend@example.com>');
  assert.equal(normalized.text, '今天好吗？');
  assert.deepEqual(normalized.attachments, [{
    id: 'attachment-1',
    filename: 'hello.pdf',
    content_type: 'application/pdf',
    size: null,
  }]);
  assert.equal('content' in normalized.attachments[0], false);
});

test('收件人校验拒绝不完整地址和过量收件人', () => {
  assert.deepEqual(validateRecipients(['a@example.com']), ['a@example.com']);
  assert.throws(() => validateRecipients(['not-an-email']), /收件人地址不正确/);
  assert.throws(() => validateRecipients(Array.from({ length: 13 }, (_, index) => `a${index}@example.com`)), /最多发送/);
});

test('同步邮箱会去重新信，同时每次检查都留下知情记录', async () => {
  const auditStore = createMemoryAuditStore();
  const service = createAgentMailService({
    runtimeConfig: createRuntimeConfig(),
    auditStore,
    fetchImpl: async url => {
      assert.match(String(url), /\/messages/);
      return jsonResponse({
        messages: [{
          message_id: 'incoming-1',
          thread_id: 'thread-1',
          from: 'friend@example.com',
          to: ['luzeeagent-4803@agentmail.to'],
          subject: '第一次来信',
          text: '你好，陆泽。',
        }],
      });
    },
  });

  const first = await service.syncInbox({ actor: 'luze' });
  const second = await service.syncInbox({ actor: 'user' });

  assert.equal(first.new_count, 1);
  assert.equal(second.new_count, 0);
  assert.equal(auditStore.rows.filter(row => row.action === 'received').length, 1);
  assert.equal(auditStore.rows.filter(row => row.action === 'checked').length, 2);
  assert.equal(auditStore.rows.find(row => row.action === 'received').body_text, '你好，陆泽。');
});

test('自主发送与回复会记录完整正文、原因和最终状态', async () => {
  const auditStore = createMemoryAuditStore();
  const service = createAgentMailService({
    runtimeConfig: createRuntimeConfig(),
    auditStore,
    fetchImpl: async (url, options) => {
      const path = String(url);
      if (options.method === 'POST' && path.endsWith('/messages/send')) {
        return jsonResponse({ message_id: 'sent-1', thread_id: 'thread-sent' });
      }
      if (options.method === 'GET' && path.endsWith('/messages/incoming-2')) {
        return jsonResponse({
          message_id: 'incoming-2',
          thread_id: 'thread-2',
          from: 'friend@example.com',
          to: ['luzeeagent-4803@agentmail.to'],
          subject: '要回复的信',
          text: '等你回信。',
        });
      }
      if (options.method === 'POST' && path.endsWith('/messages/incoming-2/reply')) {
        return jsonResponse({ message_id: 'reply-1', thread_id: 'thread-2' });
      }
      throw new Error(`unexpected request: ${options.method} ${path}`);
    },
  });

  await service.sendMessage({
    to: ['friend@example.com'],
    subject: '主动问候',
    text: '今天想起你了。',
    reason: '想主动问候朋友',
  });
  await service.replyMessage('incoming-2', {
    text: '我收到啦。',
    reason: '这封信需要回应',
  });

  const sent = auditStore.rows.find(row => row.action === 'sent');
  const replied = auditStore.rows.find(row => row.action === 'replied');
  assert.equal(sent.status, 'succeeded');
  assert.equal(sent.body_text, '今天想起你了。');
  assert.equal(sent.reason, '想主动问候朋友');
  assert.equal(replied.status, 'succeeded');
  assert.equal(replied.body_text, '我收到啦。');
  assert.equal(replied.reason, '这封信需要回应');
  assert.equal(auditStore.rows.some(row => row.action === 'read' && row.message_id === 'incoming-2'), true);
});

test('自主回复由服务器绑定当前来信，不再信任模型填写的邮件编号', async () => {
  const tool = createBoundReplyTool({
    name: 'reply_agentmail_message',
    description: '回复邮件',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        text: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['message_id', 'text', 'reason'],
    },
  });
  assert.equal('message_id' in tool.input_schema.properties, false);
  assert.deepEqual(tool.input_schema.required, ['text', 'reason']);

  const calls = [];
  const handler = createBoundReplyHandler({
    messageId: '<trusted-message@example.com>',
    onReply: async (messageId, input) => {
      calls.push({ messageId, input });
      return { ok: true };
    },
  });
  await handler({
    message_id: '<model-invented-message@example.com>',
    text: '收到啦。',
    reason: '需要回复',
  });
  assert.equal(calls[0].messageId, '<trusted-message@example.com>');
  await assert.rejects(handler({ text: '再回复一次' }), /只能自主回复一次/);
});

test('旧版编号比对失败只恢复一次，并复用原决定记录', async () => {
  const auditStore = createMemoryAuditStore();
  const service = createAgentMailService({
    runtimeConfig: createRuntimeConfig(),
    auditStore,
    fetchImpl: async () => jsonResponse({}),
  });
  const decision = await service.claimDecision({
    message_id: '<incoming@example.com>',
    thread_id: 'thread-legacy',
    from: 'friend@example.com',
    to: ['luzeeagent-4803@agentmail.to'],
    subject: '旧失败',
    text: '你好',
  });
  const failed = await service.finishDecision(decision.id, {
    status: 'failed',
    error: '只能回复当前正在处理的来信',
    metadata: { replied: false },
  });
  assert.equal(isLegacyReplyBindingFailure(failed), true);

  const retrying = await service.retryDecision(failed);
  assert.equal(retrying.id, decision.id);
  assert.equal(retrying.status, 'pending');
  assert.equal(retrying.error, '');
  assert.equal(retrying.metadata.retry_count, 1);
  assert.equal(isLegacyReplyBindingFailure(retrying), false);
  assert.equal(auditStore.rows.filter(row => row.action === 'decision').length, 1);
});

test('隐私审查拒绝时不会调用发送接口，并如实留下拦截记录', async () => {
  const auditStore = createMemoryAuditStore();
  let providerCalled = false;
  const service = createAgentMailService({
    runtimeConfig: createRuntimeConfig(),
    auditStore,
    reviewOutgoing: async () => ({
      allowed: false,
      reason: '包含私聊原文',
      safe_summary: '',
    }),
    fetchImpl: async () => {
      providerCalled = true;
      return jsonResponse({ message_id: 'must-not-send' });
    },
  });

  await assert.rejects(
    service.sendMessage({
      to: ['friend@example.com'],
      subject: '不应寄出的信',
      text: '这里是一段私人内容。',
      reason: '尝试寄信',
      contextUsed: '最近聊天',
    }),
    error => error instanceof AgentMailError && error.code === 'privacy_blocked',
  );

  assert.equal(providerCalled, false);
  const blocked = auditStore.rows.find(row => row.action === 'sent');
  assert.equal(blocked.status, 'skipped');
  assert.equal(blocked.metadata.privacy_review.allowed, false);
  assert.match(blocked.error, /私聊原文/);
});

test('Webhook 必须通过 Svix 原始正文签名校验', async () => {
  const secretBytes = crypto.randomBytes(32);
  const webhookSecret = `whsec_${secretBytes.toString('base64')}`;
  const payload = JSON.stringify({ event_type: 'message.received', data: { message_id: 'mail-1' } });
  const messageId = 'msg_test_123';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac('sha256', secretBytes)
    .update(`${messageId}.${timestamp}.${payload}`)
    .digest('base64');
  const service = createAgentMailService({
    runtimeConfig: createRuntimeConfig({ webhookSecret }),
    auditStore: createMemoryAuditStore(),
    fetchImpl: async () => jsonResponse({}),
  });

  const verified = await service.verifyWebhook(payload, {
    'svix-id': messageId,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${signature}`,
  });
  assert.equal(verified.event_type, 'message.received');

  await assert.rejects(
    service.verifyWebhook(payload, {
      'svix-id': messageId,
      'svix-timestamp': timestamp,
      'svix-signature': 'v1,invalid',
    }),
    /签名无效/,
  );
});
