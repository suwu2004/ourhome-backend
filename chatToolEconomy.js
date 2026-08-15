'use strict';

const VAULT_ECONOMY_RULE = '【金库工具省钱规则】如果叶檀已经明确给出账户名称并要求记账，直接使用 record_cat_vault_transaction 的 account_name，不要为了“确认一下”先调用 read_cat_vault；只有记录工具返回找不到账户、同名歧义，或她明确要查看余额/账本时才读取金库。多笔已明确收支应在同一个模型回合并列发出多个 record_cat_vault_transaction 调用，不要一笔一轮。';
const MEMORY_LOOKUP_ECONOMY_RULE = '【记忆检索省钱规则】search_chat_history 和 search_memories 每个回复最多调用一次。叶檀明确说“聊天记录/搜聊天/找原话”时直接调用 search_chat_history，不要先搜长期记忆；她只问“记不记得”时用 search_memories。工具返回空或报错后不要换近义词连续重试、不要在同一回复里来回切换两个检索工具；基于一次结果诚实回答即可。';

function optimizeVaultTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map(tool => {
    if (!tool || typeof tool !== 'object') return tool;
    if (tool.name === 'read_cat_vault') {
      return {
        ...tool,
        description: '查看“猫の金库”的账户、余额、本月预算、收支、目标和最近流水。仅在需要查看账本/余额，或 record_cat_vault_transaction 因账户不存在、同名歧义而失败时使用。若用户已经明确给出账户名并要求记账，不要先调用本工具；记录工具会按 account_name 在后端安全解析。',
      };
    }
    if (tool.name === 'record_cat_vault_transaction') {
      const schema = tool.input_schema && typeof tool.input_schema === 'object'
        ? { ...tool.input_schema, properties: { ...(tool.input_schema.properties || {}) } }
        : tool.input_schema;
      if (schema?.properties?.account_id) {
        schema.properties.account_id = {
          ...schema.properties.account_id,
          description: '已有准确账户编号时使用；不是必需，不要为了取得编号先读金库。',
        };
      }
      if (schema?.properties?.account_name) {
        schema.properties.account_name = {
          ...schema.properties.account_name,
          description: '账户名称。用户已明确说出账户名时直接填写，后端会安全解析；无需先 read_cat_vault。',
        };
      }
      return {
        ...tool,
        description: '在“猫の金库”真实记下一笔收入或支出并同步余额。用户明确给出金额与账户名时直接记录，不要预先读取金库；只有后端返回账户不存在/同名歧义时再读取确认。用户一次说了多笔收支时，在同一个模型回合并列发出多个本工具调用。',
        input_schema: schema,
      };
    }
    return tool;
  });
}

function optimizeMemoryLookupTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map(tool => {
    if (!tool || typeof tool !== 'object') return tool;
    if (tool.name === 'search_chat_history') {
      return {
        ...tool,
        description: '只读搜索全部可见聊天原文。叶檀明确说“聊天记录/搜聊天/找原话/之前说过”时直接使用。一个回复最多调用一次；返回空或报错后不要换关键词连续重试，也不要再改用 search_memories 兜圈子。',
      };
    }
    if (tool.name === 'search_memories') {
      return {
        ...tool,
        description: '搜索已经整理进长期记忆的内容。只用于确认记忆，不等于聊天原文搜索。一个回复最多调用一次；如果叶檀明确要求搜聊天记录，应使用 search_chat_history 而不是本工具。',
      };
    }
    return tool;
  });
}

function optimizeChatTools(tools) {
  return optimizeMemoryLookupTools(optimizeVaultTools(tools));
}

function appendRule(system, rule, marker) {
  if (typeof system === 'string') {
    if (system.includes(marker)) return system;
    return `${system}\n\n${rule}`;
  }
  if (!Array.isArray(system)) return system;
  const hasRule = system.some(block => {
    if (typeof block === 'string') return block.includes(marker);
    return String(block?.text || block?.content || '').includes(marker);
  });
  if (hasRule) return system;
  return [...system, { type: 'text', text: rule }];
}

function appendEconomyRule(system) {
  const withVault = appendRule(system, VAULT_ECONOMY_RULE, '【金库工具省钱规则】');
  return appendRule(withVault, MEMORY_LOOKUP_ECONOMY_RULE, '【记忆检索省钱规则】');
}

module.exports = {
  VAULT_ECONOMY_RULE,
  MEMORY_LOOKUP_ECONOMY_RULE,
  optimizeVaultTools,
  optimizeMemoryLookupTools,
  optimizeChatTools,
  appendEconomyRule,
};
