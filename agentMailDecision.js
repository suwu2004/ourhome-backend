'use strict';

const LEGACY_REPLY_BINDING_ERROR = '只能回复当前正在处理的来信';

function createBoundReplyTool(tool) {
  if (!tool || tool.name !== 'reply_agentmail_message') {
    throw new Error('缺少 AgentMail 回复工具');
  }
  const properties = { ...(tool.input_schema?.properties || {}) };
  delete properties.message_id;
  return {
    ...tool,
    description: `${tool.description} 当前来信已由服务器安全绑定，不需要也不能自行填写邮件编号。`,
    input_schema: {
      ...(tool.input_schema || {}),
      properties,
      required: (tool.input_schema?.required || []).filter(name => name !== 'message_id'),
    },
  };
}

function createBoundReplyHandler({ messageId, onReply }) {
  const trustedMessageId = String(messageId || '').trim();
  if (!trustedMessageId) throw new Error('缺少服务器绑定的来信编号');
  if (typeof onReply !== 'function') throw new Error('缺少 AgentMail 回复处理器');
  let attempted = false;
  return async input => {
    if (attempted) throw new Error('同一封来信只能自主回复一次');
    attempted = true;
    return onReply(trustedMessageId, input && typeof input === 'object' ? input : {});
  };
}

function isLegacyReplyBindingFailure(activity) {
  return Boolean(
    activity
    && activity.action === 'decision'
    && activity.status === 'failed'
    && activity.message_id
    && activity.error === LEGACY_REPLY_BINDING_ERROR
    && Number(activity.metadata?.retry_count || 0) < 1
  );
}

module.exports = {
  LEGACY_REPLY_BINDING_ERROR,
  createBoundReplyHandler,
  createBoundReplyTool,
  isLegacyReplyBindingFailure,
};
