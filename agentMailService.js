'use strict';

const crypto = require('crypto');
const { Webhook } = require('svix');
const {
  AgentMailError,
  DEFAULT_AGENTMAIL_BASE_URL,
  createAgentMailClient,
  toList,
} = require('./agentMail');

const MAX_BODY_CHARS = 30_000;
const MAX_SUBJECT_CHARS = 300;
const MAX_REASON_CHARS = 1200;
const MAX_RECIPIENTS = 12;
const ACTIVITY_SELECT = [
  'id', 'connection_id', 'event_key', 'action', 'direction', 'actor', 'status',
  'message_id', 'thread_id', 'subject', 'sender', 'recipients', 'body_text',
  'body_preview', 'reason', 'error', 'metadata', 'external_created_at',
  'created_at', 'updated_at',
].join(', ');

function cleanText(value, max = 500, fallback = '') {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, max);
}

function safeIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatAddress(value) {
  if (!value) return '';
  if (typeof value === 'string') return cleanText(value, 500);
  if (typeof value === 'object') {
    const email = cleanText(value.email || value.address, 320);
    const name = cleanText(value.name, 160);
    return name && email ? `${name} <${email}>` : (email || name);
  }
  return cleanText(value, 500);
}

function addressList(value) {
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  return raw.map(formatAddress).filter(Boolean).slice(0, MAX_RECIPIENTS);
}

function bareAddress(value) {
  const formatted = formatAddress(value).toLowerCase();
  const bracketed = formatted.match(/<([^<>]+)>/);
  return cleanText(bracketed?.[1] || formatted, 320);
}

function messageArray(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.messages)) return result.messages;
  if (Array.isArray(result?.data)) return result.data;
  return [];
}

function normalizeAgentMailMessage(raw, inboxId) {
  const message = raw && typeof raw === 'object' ? raw : {};
  const sender = formatAddress(message.from || message.sender);
  const recipients = addressList(message.to || message.recipients);
  const inboxAddress = bareAddress(inboxId);
  const senderAddress = bareAddress(message.from || message.sender);
  const rawDirection = cleanText(message.direction, 20).toLowerCase();
  const direction = rawDirection === 'outbound' || rawDirection === 'sent' || (senderAddress && senderAddress === inboxAddress)
    ? 'outbound'
    : 'inbound';
  const bodyText = cleanText(
    message.text
      || message.extracted_text
      || message.body?.text
      || message.preview,
    MAX_BODY_CHARS,
  );
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.slice(0, 30).map(attachment => ({
      id: cleanText(attachment?.attachment_id || attachment?.id, 300) || null,
      filename: cleanText(attachment?.filename || attachment?.name, 300) || null,
      content_type: cleanText(attachment?.content_type || attachment?.type, 160) || null,
      size: Number.isFinite(Number(attachment?.size)) ? Number(attachment.size) : null,
    }))
    : [];

  return {
    message_id: cleanText(message.message_id || message.id, 500) || null,
    thread_id: cleanText(message.thread_id || message.thread?.id, 500) || null,
    direction,
    from: sender,
    to: recipients,
    cc: addressList(message.cc),
    subject: cleanText(message.subject, MAX_SUBJECT_CHARS, '（无主题）'),
    preview: cleanText(message.preview || bodyText, 500),
    text: bodyText,
    timestamp: safeIso(message.timestamp || message.created_at || message.received_at || message.sent_at),
    labels: (Array.isArray(message.labels) ? message.labels : []).map(label => cleanText(label, 120)).filter(Boolean).slice(0, 30),
    attachments,
    headers: message.headers && typeof message.headers === 'object' ? message.headers : {},
  };
}

function validateRecipients(value) {
  const recipients = toList(value) || [];
  if (!recipients.length) throw new AgentMailError('收件人不能为空', { code: 'invalid_recipient' });
  if (recipients.length > MAX_RECIPIENTS) throw new AgentMailError(`一次最多发送给 ${MAX_RECIPIENTS} 个收件人`, { code: 'too_many_recipients' });
  for (const recipient of recipients) {
    if (recipient.length > 320 || !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(recipient)) {
      throw new AgentMailError(`收件人地址不正确：${cleanText(recipient, 80)}`, { code: 'invalid_recipient' });
    }
  }
  return recipients;
}

function isDuplicateError(error) {
  return error?.code === '23505' || /duplicate key|already exists/i.test(String(error?.message || ''));
}

function createAgentMailAuditStore(supabase) {
  async function insert(activity, { ignoreDuplicate = false } = {}) {
    const payload = {
      ...activity,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('agentmail_activity').insert(payload).select(ACTIVITY_SELECT).single();
    if (error) {
      if (ignoreDuplicate && isDuplicateError(error)) return null;
      throw error;
    }
    return data;
  }

  async function update(id, updates) {
    const { data, error } = await supabase.from('agentmail_activity')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select(ACTIVITY_SELECT)
      .single();
    if (error) throw error;
    return data;
  }

  async function list({ limit = 80, before } = {}) {
    let query = supabase.from('agentmail_activity')
      .select(ACTIVITY_SELECT)
      .order('created_at', { ascending: false })
      .limit(Math.max(1, Math.min(Number(limit) || 80, 150)));
    if (before) query = query.lt('created_at', before);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  return Object.freeze({ insert, update, list });
}

function publicActivity(activity) {
  if (!activity) return null;
  return {
    ...activity,
    body_text: cleanText(activity.body_text, MAX_BODY_CHARS),
    body_preview: cleanText(activity.body_preview || activity.body_text, 500),
    error: cleanText(activity.error, 1200),
    reason: cleanText(activity.reason, MAX_REASON_CHARS),
    recipients: Array.isArray(activity.recipients) ? activity.recipients : [],
    metadata: activity.metadata && typeof activity.metadata === 'object' ? activity.metadata : {},
  };
}

function createAgentMailService({
  runtimeConfig,
  auditStore,
  fetchImpl = globalThis.fetch,
  reviewOutgoing,
} = {}) {
  if (!runtimeConfig) throw new Error('AgentMail 需要 runtimeConfig');
  if (!auditStore) throw new Error('AgentMail 需要 auditStore');
  const runPrivacyReview = typeof reviewOutgoing === 'function'
    ? reviewOutgoing
    : async () => ({ allowed: true, reason: '未配置额外隐私审查', safe_summary: '' });

  async function getConnection({ allowDisabled = true } = {}) {
    const connections = await runtimeConfig.listConnections();
    const connection = connections.find(item => item.kind === 'agentmail') || null;
    if (!connection) return null;
    if (!allowDisabled && !connection.enabled) {
      throw new AgentMailError('陆泽邮箱目前已暂停', { status: 409, code: 'disabled' });
    }
    return connection;
  }

  async function loadRuntime({ allowDisabled = false } = {}) {
    const publicConnection = await getConnection({ allowDisabled });
    if (!publicConnection) {
      throw new AgentMailError('请先在设置里连接陆泽邮箱', { status: 409, code: 'not_configured' });
    }
    const connection = await runtimeConfig.getConnectionRuntime(publicConnection.id);
    if (!connection?.secret) {
      throw new AgentMailError('陆泽邮箱还没有保存 AgentMail API 密钥', { status: 409, code: 'not_configured' });
    }
    const inboxId = cleanText(connection.config?.inbox_id || connection.config?.email, 500);
    if (!inboxId) {
      throw new AgentMailError('陆泽邮箱地址还没有配置', { status: 409, code: 'not_configured' });
    }
    const client = createAgentMailClient({
      apiKey: connection.secret,
      inboxId,
      baseUrl: connection.url || DEFAULT_AGENTMAIL_BASE_URL,
      fetchImpl,
    });
    return { connection, client, inboxId };
  }

  async function getPublicConfig() {
    const connection = await getConnection();
    if (!connection) {
      return {
        configured: false,
        enabled: false,
        autonomous: true,
        inbox_id: 'luzeeagent-4803@agentmail.to',
        has_api_key: false,
        has_webhook_secret: false,
      };
    }
    return {
      configured: true,
      id: connection.id,
      enabled: Boolean(connection.enabled),
      autonomous: connection.config?.autonomous !== false,
      knowledge_mode: 'full',
      inbox_id: cleanText(connection.config?.inbox_id || connection.config?.email, 500),
      email: cleanText(connection.config?.email || connection.config?.inbox_id, 500),
      has_api_key: Boolean(connection.has_secret),
      has_webhook_secret: Boolean(connection.has_webhook_secret),
      webhook_registered_at: connection.config?.webhook_registered_at || null,
      webhook_url: connection.config?.webhook_url || null,
    };
  }

  async function saveConfig({ inboxId, apiKey, enabled = true, autonomous = true } = {}) {
    const normalizedInbox = cleanText(inboxId, 500);
    if (!normalizedInbox || /\s/.test(normalizedInbox)) {
      throw new AgentMailError('请填写正确的 AgentMail 邮箱地址或 Inbox ID', { status: 400, code: 'invalid_inbox' });
    }
    const existing = await getConnection();
    if (!existing?.has_secret && !cleanText(apiKey, 4000)) {
      throw new AgentMailError('第一次连接需要填写 AgentMail API 密钥', { status: 400, code: 'missing_api_key' });
    }
    const inboxChanged = Boolean(existing && cleanText(existing.config?.inbox_id, 500) !== normalizedInbox);
    const preservedConfig = inboxChanged ? {} : (existing?.config || {});
    const saved = await runtimeConfig.saveConnection({
      id: existing?.id || null,
      kind: 'agentmail',
      name: '陆泽邮箱',
      url: DEFAULT_AGENTMAIL_BASE_URL,
      secret: cleanText(apiKey, 4000) || null,
      enabled: Boolean(enabled),
      config: {
        ...preservedConfig,
        inbox_id: normalizedInbox,
        email: normalizedInbox,
        autonomous: Boolean(autonomous),
        knowledge_mode: 'full',
      },
    });
    if (inboxChanged && existing?.has_webhook_secret) {
      await runtimeConfig.saveAgentMailWebhookSecret(saved.id, null);
    }
    return getPublicConfig();
  }

  async function deleteConfig() {
    const connection = await getConnection();
    if (!connection) return false;
    await runtimeConfig.deleteConnection(connection.id);
    return true;
  }

  async function testConnection({ actor = 'user' } = {}) {
    let activity;
    try {
      const runtime = await loadRuntime({ allowDisabled: true });
      activity = await auditStore.insert({
        connection_id: runtime.connection.id,
        action: 'configuration_test',
        direction: 'internal',
        actor,
        status: 'pending',
        subject: '测试 AgentMail 连接',
        reason: '从 OurHome 设置页发起',
        metadata: {},
      });
      const inbox = await runtime.client.getInbox();
      await auditStore.update(activity.id, {
        status: 'succeeded',
        reason: 'AgentMail 连接正常',
        metadata: { inbox_id: inbox?.inbox_id || runtime.inboxId, email: inbox?.email || runtime.inboxId },
      });
      return {
        ok: true,
        inbox_id: inbox?.inbox_id || runtime.inboxId,
        email: inbox?.email || runtime.inboxId,
        display_name: inbox?.display_name || null,
      };
    } catch (error) {
      if (activity?.id) {
        await auditStore.update(activity.id, { status: 'failed', error: cleanText(error.message, 1200) }).catch(() => {});
      }
      throw error;
    }
  }

  async function insertObservedMessage(runtime, message, source) {
    if (!message.message_id) return null;
    const action = message.direction === 'outbound' ? 'sent' : 'received';
    return auditStore.insert({
      connection_id: runtime.connection.id,
      event_key: `agentmail:${action}:${message.message_id}`,
      action,
      direction: message.direction,
      actor: message.direction === 'outbound' ? 'luze' : 'system',
      status: 'succeeded',
      message_id: message.message_id,
      thread_id: message.thread_id,
      subject: message.subject,
      sender: message.from,
      recipients: message.to,
      body_text: message.text,
      body_preview: message.preview,
      reason: message.direction === 'outbound' ? '从 AgentMail 同步到一封已寄邮件' : 'AgentMail 收到新邮件',
      metadata: { source, labels: message.labels, attachments: message.attachments },
      external_created_at: message.timestamp,
    }, { ignoreDuplicate: true });
  }

  async function syncInbox({ actor = 'user', limit = 30 } = {}) {
    const runtime = await loadRuntime();
    const result = await runtime.client.listMessages({ limit: Math.max(1, Math.min(Number(limit) || 30, 60)) });
    const messages = messageArray(result).map(item => normalizeAgentMailMessage(item, runtime.inboxId)).filter(item => item.message_id);
    const newInbound = [];
    for (const message of messages) {
      const inserted = await insertObservedMessage(runtime, message, 'sync');
      if (inserted && message.direction === 'inbound') newInbound.push(message);
    }
    await auditStore.insert({
      connection_id: runtime.connection.id,
      action: 'checked',
      direction: 'internal',
      actor,
      status: 'succeeded',
      subject: '查看陆泽邮箱',
      reason: actor === 'luze' ? '陆泽主动检查了邮箱' : '叶檀刷新了邮箱记录',
      metadata: { message_count: messages.length, new_inbound_count: newInbound.length },
    });
    return {
      ok: true,
      count: messages.length,
      new_count: newInbound.length,
      messages,
      new_inbound: newInbound,
      next_page_token: result?.next_page_token || result?.next_page || null,
    };
  }

  async function getMessage(messageId, { actor = 'luze', reason = '' } = {}) {
    const runtime = await loadRuntime();
    const raw = await runtime.client.getMessage(cleanText(messageId, 500));
    const message = normalizeAgentMailMessage(raw, runtime.inboxId);
    await auditStore.insert({
      connection_id: runtime.connection.id,
      action: 'read',
      direction: message.direction,
      actor,
      status: 'succeeded',
      message_id: message.message_id,
      thread_id: message.thread_id,
      subject: message.subject,
      sender: message.from,
      recipients: message.to,
      body_text: message.text,
      body_preview: message.preview,
      reason: cleanText(reason, MAX_REASON_CHARS, actor === 'luze' ? '陆泽打开并阅读了这封邮件' : '叶檀查看了邮件详情'),
      metadata: { labels: message.labels, attachments: message.attachments },
      external_created_at: message.timestamp,
    });
    return message;
  }

  async function sendMessage({ to, subject, text, reason = '', contextUsed = '' }, { actor = 'luze' } = {}) {
    const runtime = await loadRuntime();
    const recipients = validateRecipients(to);
    const safeSubject = cleanText(subject, MAX_SUBJECT_CHARS, '（无主题）');
    const safeBody = cleanText(text, MAX_BODY_CHARS);
    if (!safeBody) throw new AgentMailError('邮件正文不能为空', { status: 400, code: 'invalid_body' });
    const activity = await auditStore.insert({
      connection_id: runtime.connection.id,
      action: 'sent',
      direction: 'outbound',
      actor,
      status: 'pending',
      subject: safeSubject,
      sender: runtime.inboxId,
      recipients,
      body_text: safeBody,
      body_preview: safeBody.slice(0, 500),
      reason: cleanText(reason, MAX_REASON_CHARS, '陆泽自主决定寄出这封邮件'),
      metadata: { context_used: cleanText(contextUsed, 1200) || null },
    });
    try {
      const privacy = await runPrivacyReview({
        action: 'send',
        to: recipients,
        subject: safeSubject,
        text: safeBody,
        contextUsed: cleanText(contextUsed, 1200),
      });
      if (!privacy?.allowed) {
        await auditStore.update(activity.id, {
          event_key: `agentmail:privacy-blocked:${activity.id}`,
          status: 'skipped',
          error: cleanText(privacy?.reason, 1200, '邮件包含不适合外发的私人内容'),
          metadata: {
            context_used: cleanText(contextUsed, 1200) || null,
            privacy_review: {
              allowed: false,
              reason: cleanText(privacy?.reason, 1200),
            },
          },
        });
        throw new AgentMailError('这封邮件涉及我们的隐私，已经拦下，没有寄出', {
          status: 409,
          code: 'privacy_blocked',
        });
      }
      const result = await runtime.client.sendMessage({ to: recipients, subject: safeSubject, text: safeBody });
      const message = normalizeAgentMailMessage({
        ...result,
        from: result?.from || runtime.inboxId,
        to: result?.to || recipients,
        subject: result?.subject || safeSubject,
        text: result?.text || safeBody,
      }, runtime.inboxId);
      const updated = await auditStore.update(activity.id, {
        event_key: message.message_id ? `agentmail:sent:${message.message_id}` : `agentmail:sent-request:${activity.id}`,
        status: 'succeeded',
        message_id: message.message_id,
        thread_id: message.thread_id,
        external_created_at: message.timestamp,
        metadata: {
          context_used: cleanText(contextUsed, 1200) || null,
          privacy_review: {
            allowed: true,
            reason: cleanText(privacy?.reason, 1200),
            safe_summary: cleanText(privacy?.safe_summary, 1200),
          },
          provider_response: { message_id: message.message_id, thread_id: message.thread_id },
        },
      });
      return { ok: true, message, activity: publicActivity(updated) };
    } catch (error) {
      if (error instanceof AgentMailError && error.code === 'privacy_blocked') throw error;
      await auditStore.update(activity.id, {
        event_key: `agentmail:sent-failed:${activity.id}`,
        status: 'failed',
        error: cleanText(error.message, 1200),
      }).catch(() => {});
      throw error;
    }
  }

  async function replyMessage(messageId, {
    text,
    replyAll = false,
    reason = '',
    contextUsed = '',
  }, { actor = 'luze' } = {}) {
    const runtime = await loadRuntime();
    const targetId = cleanText(messageId, 500);
    if (!targetId) throw new AgentMailError('缺少要回复的邮件编号', { status: 400, code: 'invalid_message' });
    const safeBody = cleanText(text, MAX_BODY_CHARS);
    if (!safeBody) throw new AgentMailError('回复正文不能为空', { status: 400, code: 'invalid_body' });
    const originalRaw = await runtime.client.getMessage(targetId);
    const original = normalizeAgentMailMessage(originalRaw, runtime.inboxId);
    await auditStore.insert({
      connection_id: runtime.connection.id,
      action: 'read',
      direction: original.direction,
      actor,
      status: 'succeeded',
      message_id: original.message_id || targetId,
      thread_id: original.thread_id,
      subject: original.subject,
      sender: original.from,
      recipients: original.to,
      body_text: original.text,
      body_preview: original.preview,
      reason: '陆泽在回复前读了这封邮件',
      metadata: { attachments: original.attachments },
      external_created_at: original.timestamp,
    });
    const recipients = original.from ? [original.from] : [];
    const activity = await auditStore.insert({
      connection_id: runtime.connection.id,
      action: 'replied',
      direction: 'outbound',
      actor,
      status: 'pending',
      message_id: targetId,
      thread_id: original.thread_id,
      subject: original.subject,
      sender: runtime.inboxId,
      recipients,
      body_text: safeBody,
      body_preview: safeBody.slice(0, 500),
      reason: cleanText(reason, MAX_REASON_CHARS, '陆泽自主决定回复这封邮件'),
      metadata: {
        reply_all: Boolean(replyAll),
        in_reply_to: targetId,
        context_used: cleanText(contextUsed, 1200) || null,
      },
    });
    try {
      const privacy = await runPrivacyReview({
        action: 'reply',
        to: recipients,
        subject: original.subject,
        text: safeBody,
        contextUsed: cleanText(contextUsed, 1200),
      });
      if (!privacy?.allowed) {
        await auditStore.update(activity.id, {
          event_key: `agentmail:privacy-blocked:${activity.id}`,
          status: 'skipped',
          error: cleanText(privacy?.reason, 1200, '回复包含不适合外发的私人内容'),
          metadata: {
            reply_all: Boolean(replyAll),
            in_reply_to: targetId,
            context_used: cleanText(contextUsed, 1200) || null,
            privacy_review: {
              allowed: false,
              reason: cleanText(privacy?.reason, 1200),
            },
          },
        });
        throw new AgentMailError('这封回复涉及我们的隐私，已经拦下，没有寄出', {
          status: 409,
          code: 'privacy_blocked',
        });
      }
      const result = await runtime.client.replyMessage(targetId, { text: safeBody, replyAll: Boolean(replyAll) });
      const reply = normalizeAgentMailMessage({
        ...result,
        from: result?.from || runtime.inboxId,
        to: result?.to || recipients,
        subject: result?.subject || original.subject,
        text: result?.text || safeBody,
      }, runtime.inboxId);
      const updated = await auditStore.update(activity.id, {
        event_key: reply.message_id ? `agentmail:sent:${reply.message_id}` : `agentmail:reply-request:${activity.id}`,
        status: 'succeeded',
        message_id: reply.message_id || targetId,
        thread_id: reply.thread_id || original.thread_id,
        external_created_at: reply.timestamp,
        metadata: {
          reply_all: Boolean(replyAll),
          in_reply_to: targetId,
          context_used: cleanText(contextUsed, 1200) || null,
          privacy_review: {
            allowed: true,
            reason: cleanText(privacy?.reason, 1200),
            safe_summary: cleanText(privacy?.safe_summary, 1200),
          },
          provider_response: { message_id: reply.message_id, thread_id: reply.thread_id },
        },
      });
      return { ok: true, message: reply, activity: publicActivity(updated) };
    } catch (error) {
      if (error instanceof AgentMailError && error.code === 'privacy_blocked') throw error;
      await auditStore.update(activity.id, {
        event_key: `agentmail:reply-failed:${activity.id}`,
        status: 'failed',
        error: cleanText(error.message, 1200),
      }).catch(() => {});
      throw error;
    }
  }

  async function listActivity(options = {}) {
    const rows = await auditStore.list(options);
    return rows.map(publicActivity);
  }

  async function recordWebhookMessage(payload) {
    const eventType = cleanText(payload?.event_type || payload?.type, 120);
    if (eventType && eventType !== 'message.received') {
      return { accepted: true, ignored: true, reason: `暂不处理 ${eventType}` };
    }
    const runtime = await loadRuntime({ allowDisabled: true });
    const rawMessage = payload?.data?.message || payload?.data || payload?.message || payload;
    const message = normalizeAgentMailMessage(rawMessage, runtime.inboxId);
    if (!message.message_id) throw new AgentMailError('AgentMail Webhook 缺少邮件编号', { status: 400, code: 'invalid_webhook' });
    if (message.direction === 'outbound') {
      const activity = await insertObservedMessage(runtime, message, 'webhook');
      return { accepted: true, ignored: true, message, activity: publicActivity(activity) };
    }
    const activity = await insertObservedMessage(runtime, message, 'webhook');
    return { accepted: true, is_new: Boolean(activity), message, activity: publicActivity(activity) };
  }

  async function claimDecision(message) {
    const runtime = await loadRuntime({ allowDisabled: true });
    const target = normalizeAgentMailMessage(message, runtime.inboxId);
    return auditStore.insert({
      connection_id: runtime.connection.id,
      event_key: `agentmail:decision:${target.message_id}`,
      action: 'decision',
      direction: 'inbound',
      actor: 'luze',
      status: 'pending',
      message_id: target.message_id,
      thread_id: target.thread_id,
      subject: target.subject,
      sender: target.from,
      recipients: target.to,
      body_text: target.text,
      body_preview: target.preview,
      reason: '陆泽正在判断要不要回复',
      metadata: {},
      external_created_at: target.timestamp,
    }, { ignoreDuplicate: true });
  }

  async function finishDecision(activityId, { status = 'succeeded', reason = '', error = '', metadata = {} } = {}) {
    if (!activityId) return null;
    return publicActivity(await auditStore.update(activityId, {
      status,
      reason: cleanText(reason, MAX_REASON_CHARS),
      error: cleanText(error, 1200),
      metadata,
    }));
  }

  async function registerWebhook(webhookUrl) {
    const runtime = await loadRuntime({ allowDisabled: true });
    const url = new URL(webhookUrl);
    if (url.protocol !== 'https:') {
      throw new AgentMailError('实时收信地址必须使用 HTTPS', { status: 400, code: 'invalid_webhook_url' });
    }
    const result = await runtime.client.createWebhook({
      url: url.toString(),
      eventTypes: ['message.received'],
      clientId: `ourhome-${runtime.connection.id}`,
    });
    const secret = cleanText(result?.secret || result?.signing_secret, 4000);
    if (!secret) throw new AgentMailError('AgentMail 没有返回 Webhook 签名密钥', { code: 'missing_webhook_secret' });
    await runtimeConfig.saveAgentMailWebhookSecret(runtime.connection.id, secret);
    const saved = await runtimeConfig.saveConnection({
      id: runtime.connection.id,
      kind: 'agentmail',
      name: runtime.connection.name,
      url: runtime.connection.url,
      secret: null,
      enabled: runtime.connection.enabled,
      config: {
        ...(runtime.connection.config || {}),
        webhook_id: cleanText(result?.webhook_id || result?.id, 500) || null,
        webhook_url: url.toString(),
        webhook_registered_at: new Date().toISOString(),
      },
    });
    await auditStore.insert({
      connection_id: saved.id,
      event_key: `agentmail:webhook:${cleanText(result?.webhook_id || result?.id, 500) || crypto.randomUUID()}`,
      action: 'webhook_registered',
      direction: 'internal',
      actor: 'user',
      status: 'succeeded',
      subject: '实时收信已接通',
      reason: 'AgentMail 会把新邮件安全通知给 OurHome',
      metadata: { webhook_url: url.toString(), event_types: ['message.received'] },
    }, { ignoreDuplicate: true });
    return getPublicConfig();
  }

  async function verifyWebhook(rawBody, headers) {
    const connection = await getConnection({ allowDisabled: true });
    if (!connection) throw new AgentMailError('陆泽邮箱尚未配置', { status: 503, code: 'not_configured' });
    const secret = await runtimeConfig.getAgentMailWebhookSecret(connection.id);
    if (!secret) throw new AgentMailError('实时收信签名密钥尚未配置', { status: 503, code: 'webhook_not_configured' });
    const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
    try {
      return await Promise.resolve(new Webhook(secret).verify(payload, {
        'svix-id': headers['svix-id'],
        'svix-timestamp': headers['svix-timestamp'],
        'svix-signature': headers['svix-signature'],
      }));
    } catch {
      throw new AgentMailError('AgentMail Webhook 签名无效', { status: 401, code: 'invalid_signature' });
    }
  }

  return Object.freeze({
    claimDecision,
    deleteConfig,
    finishDecision,
    getMessage,
    getPublicConfig,
    listActivity,
    loadRuntime,
    recordWebhookMessage,
    registerWebhook,
    replyMessage,
    saveConfig,
    sendMessage,
    syncInbox,
    testConnection,
    verifyWebhook,
  });
}

module.exports = {
  MAX_BODY_CHARS,
  createAgentMailAuditStore,
  createAgentMailService,
  normalizeAgentMailMessage,
  publicActivity,
  validateRecipients,
};
