'use strict';

const DEFAULT_AGENTMAIL_BASE_URL = 'https://api.agentmail.to/v0';
const DEFAULT_TIMEOUT_MS = 15_000;

class AgentMailError extends Error {
  constructor(message, { status = 0, code = '', details = null } = {}) {
    super(message);
    this.name = 'AgentMailError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function required(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new AgentMailError(`${label}未配置`, { code: 'not_configured' });
  return normalized;
}

function toList(value) {
  if (value == null || value === '') return undefined;
  const list = (Array.isArray(value) ? value : [value])
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

function createAgentMailClient({
  apiKey,
  inboxId,
  baseUrl = DEFAULT_AGENTMAIL_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = required(apiKey, 'AgentMail API 密钥');
  const inbox = required(inboxId, 'AgentMail 邮箱地址');
  const cleanBaseUrl = required(baseUrl, 'AgentMail API 地址').replace(/\/+$/, '');
  if (typeof fetchImpl !== 'function') throw new AgentMailError('当前运行环境不支持网络请求', { code: 'fetch_unavailable' });

  async function request(path, { method = 'GET', body, query, timeout = timeoutMs } = {}) {
    const url = new URL(`${cleanBaseUrl}${path}`);
    if (query) {
      for (const [name, value] of Object.entries(query)) {
        if (value == null || value === '') continue;
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(name, String(item));
        } else {
          url.searchParams.set(name, String(value));
        }
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const raw = await response.text();
      let data = null;
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = { raw: raw.slice(0, 1200) };
        }
      }

      if (!response.ok) {
        const message = data?.message || data?.error?.message || data?.error || `AgentMail 请求失败 (${response.status})`;
        throw new AgentMailError(String(message), {
          status: response.status,
          code: String(data?.code || data?.error?.code || ''),
          details: data,
        });
      }
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') throw new AgentMailError('AgentMail 请求超时', { code: 'timeout' });
      if (error instanceof AgentMailError) throw error;
      throw new AgentMailError(`AgentMail 暂时连接不上：${error?.message || '网络错误'}`, { code: 'network_error' });
    } finally {
      clearTimeout(timer);
    }
  }

  const encodedInbox = encodeURIComponent(inbox);

  return Object.freeze({
    inboxId: inbox,

    getInbox() {
      return request(`/inboxes/${encodedInbox}`);
    },

    listMessages({
      limit = 20,
      pageToken,
      labels,
      before,
      after,
      ascending = false,
      includeSpam = false,
      includeBlocked = false,
      includeUnauthenticated = false,
      includeTrash = false,
      from,
      to,
      subject,
    } = {}) {
      return request(`/inboxes/${encodedInbox}/messages`, {
        query: {
          limit: Math.max(1, Math.min(Number(limit) || 20, 100)),
          page_token: pageToken,
          labels,
          before,
          after,
          ascending,
          include_spam: includeSpam,
          include_blocked: includeBlocked,
          include_unauthenticated: includeUnauthenticated,
          include_trash: includeTrash,
          from,
          to,
          subject,
        },
      });
    },

    getMessage(messageId) {
      const id = required(messageId, '邮件编号');
      return request(`/inboxes/${encodedInbox}/messages/${encodeURIComponent(id)}`);
    },

    sendMessage({ to, cc, bcc, subject, text, html, replyTo, labels, attachments, headers } = {}) {
      const recipients = toList(to);
      if (!recipients?.length) throw new AgentMailError('收件人不能为空', { code: 'invalid_recipient' });
      if (!text && !html) throw new AgentMailError('邮件正文不能为空', { code: 'invalid_body' });

      return request(`/inboxes/${encodedInbox}/messages/send`, {
        method: 'POST',
        body: {
          to: recipients,
          ...(toList(cc) ? { cc: toList(cc) } : {}),
          ...(toList(bcc) ? { bcc: toList(bcc) } : {}),
          ...(subject ? { subject: String(subject) } : {}),
          ...(text ? { text: String(text) } : {}),
          ...(html ? { html: String(html) } : {}),
          ...(toList(replyTo) ? { reply_to: toList(replyTo) } : {}),
          ...(toList(labels) ? { labels: toList(labels) } : {}),
          ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
          ...(headers && typeof headers === 'object' ? { headers } : {}),
        },
      });
    },

    replyMessage(messageId, { text, html, replyAll = false, to, cc, bcc, replyTo, labels, attachments, headers } = {}) {
      const id = required(messageId, '邮件编号');
      if (!text && !html) throw new AgentMailError('回复正文不能为空', { code: 'invalid_body' });

      return request(`/inboxes/${encodedInbox}/messages/${encodeURIComponent(id)}/reply`, {
        method: 'POST',
        body: {
          reply_all: Boolean(replyAll),
          ...(text ? { text: String(text) } : {}),
          ...(html ? { html: String(html) } : {}),
          ...(toList(to) ? { to: toList(to) } : {}),
          ...(toList(cc) ? { cc: toList(cc) } : {}),
          ...(toList(bcc) ? { bcc: toList(bcc) } : {}),
          ...(toList(replyTo) ? { reply_to: toList(replyTo) } : {}),
          ...(toList(labels) ? { labels: toList(labels) } : {}),
          ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
          ...(headers && typeof headers === 'object' ? { headers } : {}),
        },
      });
    },

    createWebhook({ url, eventTypes = ['message.received'], clientId } = {}) {
      const webhookUrl = required(url, 'Webhook 地址');
      const types = toList(eventTypes);
      if (!types?.length) throw new AgentMailError('Webhook 事件不能为空', { code: 'invalid_events' });
      return request(`/inboxes/${encodedInbox}/webhooks`, {
        method: 'POST',
        body: {
          url: webhookUrl,
          event_types: types,
          ...(clientId ? { client_id: String(clientId) } : {}),
        },
      });
    },
  });
}

module.exports = {
  AgentMailError,
  DEFAULT_AGENTMAIL_BASE_URL,
  createAgentMailClient,
  toList,
};
