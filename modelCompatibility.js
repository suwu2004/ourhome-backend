const { normalizeMcpInputSchema } = require('./mcpSchema');

const TEXT_TOOL_CALL_RE = /<ourhome_tool>\s*([\s\S]*?)\s*<\/ourhome_tool>/gi;
const TEXT_TOOL_RESULT_RE = /<ourhome_tool_result>[\s\S]*?<\/ourhome_tool_result>/gi;

function compactProperty(property = {}, depth = 0) {
  const value = {};
  if (property.type) value.type = property.type;
  if (Array.isArray(property.enum)) value.enum = property.enum;
  if (property.description) value.description = String(property.description).slice(0, 110);
  if (depth < 3 && property.type === 'object' && property.properties) {
    value.properties = Object.fromEntries(
      Object.entries(property.properties).map(([name, child]) => [name, compactProperty(child, depth + 1)]),
    );
    if (Array.isArray(property.required) && property.required.length) value.required = property.required;
  }
  if (depth < 3 && property.type === 'array' && property.items) {
    value.items = compactProperty(property.items, depth + 1);
  }
  return value;
}

function compactTool(tool = {}) {
  const { schema } = normalizeMcpInputSchema(tool.input_schema || tool.inputSchema);
  const properties = Object.fromEntries(
    Object.entries(schema.properties || {}).map(([name, property]) => [name, compactProperty(property)]),
  );
  return {
    name: tool.name,
    description: String(tool.description || '').slice(0, 180),
    input: {
      required: Array.isArray(schema.required) ? schema.required : [],
      properties,
    },
  };
}

function buildTextToolBridge(tools = []) {
  const available = tools.filter(tool => tool?.name).map(compactTool);
  if (!available.length) return '';
  return `

【OurHome 工具兼容协议】
下列工具是真实可执行的，不是示例。优先使用接口提供的原生工具调用；如果当前模型线路没有显示原生工具按钮，也绝对不要声称“没有权限”或“没有工具”。需要读取或操作时，只输出一个严格标签，等待系统执行：
<ourhome_tool>{"name":"工具名","input":{}}</ourhome_tool>
一次只请求一个工具；标签外不要写解释。系统返回 <ourhome_tool_result> 后，再根据真实结果继续回答或请求下一项。只有工具返回成功，才可以说操作已经完成。设置房间没有任何工具，仍然不可修改。

可用工具：
${JSON.stringify(available)}`;
}

function resultText(result) {
  return (result?.content || [])
    .filter(block => block?.type === 'text')
    .map(block => String(block.text || ''))
    .join('\n');
}

function parseTextToolCalls(result) {
  const calls = [];
  const text = resultText(result);
  for (const match of text.matchAll(TEXT_TOOL_CALL_RE)) {
    try {
      const parsed = JSON.parse(match[1]);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate.name !== 'string') continue;
        calls.push({
          name: candidate.name.trim(),
          input: candidate.input && typeof candidate.input === 'object' && !Array.isArray(candidate.input)
            ? candidate.input
            : {},
        });
        if (calls.length >= 5) return calls;
      }
    } catch {
      // 格式不完整时不执行，避免把普通聊天误当成真实操作。
    }
  }
  return calls;
}

function stripTextToolMarkup(value) {
  return String(value || '')
    .replace(TEXT_TOOL_CALL_RE, '')
    .replace(TEXT_TOOL_RESULT_RE, '')
    .trim();
}

function isToolCompatibilityError(error) {
  const raw = String(error?.message || error || '');
  return /(tool(_choice|s)?|function.?call|function.?declaration).{0,80}(unsupported|not supported|does not support|unknown|invalid|not allowed|unrecognized)|(unsupported|not supported|does not support|unknown|invalid|not allowed|unrecognized).{0,80}(tool(_choice|s)?|function.?call|function.?declaration)|unknown (field|parameter).{0,30}(tool|function)|不支持.{0,30}(工具|函数)/i.test(raw);
}

function hasImageContent(messages = []) {
  return messages.some(message => Array.isArray(message?.content)
    && message.content.some(block => block?.type === 'image'));
}

function isLikelyVisionModel(model) {
  const name = String(model || '').toLowerCase();
  return /(claude|gemini|gpt-(4o|4\.1|5)|o[134]-vision|qwen[^/]*vl|qvq|glm-4v|pixtral|llava|internvl|minicpm-v|molmo|vision|multimodal)/i.test(name);
}

function visionModelRank(model) {
  const priority = [
    /claude-(4|3)/i,
    /gemini-(3|2\.5|2)/i,
    /gpt-(5|4\.1|4o)/i,
    /qwen[^/]*vl|qvq/i,
    /glm-4v|pixtral|llava|internvl|vision|multimodal/i,
  ];
  const rank = priority.findIndex(pattern => pattern.test(model));
  return rank < 0 ? priority.length : rank;
}

function listVisionModels(models = [], currentModel = '') {
  const current = String(currentModel || '');
  const candidates = [...new Set([current, ...(models || [])].map(String).filter(Boolean))]
    .filter(isLikelyVisionModel);
  candidates.sort((left, right) => {
    if (left === current) return -1;
    if (right === current) return 1;
    return visionModelRank(left) - visionModelRank(right);
  });
  return candidates;
}

function chooseVisionModel(models = [], currentModel = '') {
  const current = String(currentModel || '');
  return listVisionModels(models, current).find(model => model !== current) || null;
}

function parseVisionReaderOutput(value) {
  const text = String(value || '')
    .trim()
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  const lead = text.slice(0, 240);
  if (/IMAGE[ _-]*UNAVAILABLE\b/i.test(lead)) return '';

  const marker = text.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?IMAGE[ _-]*OK(?:\*\*)?\s*(?:[:：-]\s*)?(?:\n|\s+)([\s\S]+)$/i);
  const description = marker?.[1]?.trim() || '';
  if (!description || /^IMAGE[ _-]*(?:OK|UNAVAILABLE)\b/i.test(description)) return '';
  return description;
}

function replaceImagesWithDescription(messages = [], description, visionModel) {
  return messages.map(message => {
    if (!Array.isArray(message?.content) || !message.content.some(block => block?.type === 'image')) return message;
    const text = message.content
      .filter(block => block?.type === 'text')
      .map(block => block.text || '')
      .filter(Boolean)
      .join('\n');
    return {
      ...message,
      content: `${text}${text ? '\n\n' : ''}【图片代读 · ${visionModel}】\n${description}`,
    };
  });
}

module.exports = {
  buildTextToolBridge,
  parseTextToolCalls,
  stripTextToolMarkup,
  isToolCompatibilityError,
  hasImageContent,
  isLikelyVisionModel,
  listVisionModels,
  chooseVisionModel,
  parseVisionReaderOutput,
  replaceImagesWithDescription,
};
