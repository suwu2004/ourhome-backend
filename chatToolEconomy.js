'use strict';

const VAULT_ECONOMY_RULE = '【金库工具省钱规则】如果叶檀已经明确给出账户名称并要求记账，直接使用 record_cat_vault_transaction 的 account_name，不要为了“确认一下”先调用 read_cat_vault；只有记录工具返回找不到账户、同名歧义，或她明确要查看余额/账本时才读取金库。多笔已明确收支应在同一个模型回合并列发出多个 record_cat_vault_transaction 调用，不要一笔一轮。';

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

function appendEconomyRule(system) {
  if (typeof system === 'string') {
    if (system.includes('【金库工具省钱规则】')) return system;
    return `${system}\n\n${VAULT_ECONOMY_RULE}`;
  }
  if (!Array.isArray(system)) return system;
  const hasRule = system.some(block => {
    if (typeof block === 'string') return block.includes('【金库工具省钱规则】');
    return String(block?.text || block?.content || '').includes('【金库工具省钱规则】');
  });
  if (hasRule) return system;
  return [...system, { type: 'text', text: VAULT_ECONOMY_RULE }];
}

module.exports = { VAULT_ECONOMY_RULE, optimizeVaultTools, appendEconomyRule };
