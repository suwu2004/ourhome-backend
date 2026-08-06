const MAX_CONTEXT_CHARS = 6_000;
const MAX_REPLY_CHARS = 8_000;
const MAX_THOUGHT_CHARS = 12_000;

function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string' || typeof content === 'number') return String(content);
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block;
        if (!block || typeof block !== 'object') return '';
        if (typeof block.text === 'string') return block.text;
        if (typeof block.content === 'string') return block.content;
        if (block.type === 'image' || block.type === 'image_url') return '[图片]';
        if (block.type === 'tool_result') return contentText(block.content);
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') {
    return contentText(content.text || content.content || content.value || '');
  }
  return '';
}

function extractResponseText(result = {}) {
  if (typeof result?.content === 'string') return result.content;
  if (Array.isArray(result?.content)) {
    const text = result.content
      .filter(block => !block?.type || block.type === 'text' || block.type === 'output_text')
      .map(block => contentText(block))
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }

  for (const choice of Array.isArray(result?.choices) ? result.choices : []) {
    const text = contentText(choice?.message?.content || choice?.delta?.content || choice?.text);
    if (text) return text;
  }

  return contentText(result?.text || result?.output_text || result?.message?.content);
}

function normalizeVisibleThought(value) {
  return String(value || '')
    .replace(/```(?:thinking|analysis|text)?\s*/gi, '')
    .replace(/```/g, '')
    .replace(/<\/?(?:thinking|think|analysis|reasoning|thinking_summary|reasoning_summary)\b[^>]*>/gi, '')
    .replace(/^\s*(?:可见思考|思考过程|思考记录|想了想)\s*[:：]\s*/u, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, MAX_THOUGHT_CHARS);
}

function recentConversationText(messages) {
  const rows = (Array.isArray(messages) ? messages : [])
    .slice(-6)
    .map(message => {
      const role = message?.role === 'assistant' ? '陆泽' : '叶檀';
      const text = contentText(message?.content)
        .replace(/data:[^\s]+/gi, '[附件]')
        .replace(/https?:\/\/\S{500,}/gi, '[长链接]')
        .trim();
      return text ? `${role}：${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
  return rows.slice(-MAX_CONTEXT_CHARS);
}

function latestUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role !== 'user') continue;
    const text = contentText(list[index]?.content).replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 160);
  }
  return '';
}

function buildFallbackPrompt(messages, replyText) {
  const conversation = recentConversationText(messages) || '（没有可用的文字上下文）';
  const reply = String(replyText || '').trim().slice(0, MAX_REPLY_CHARS) || '（正式回复为空）';
  return `请为下面这轮对话补写一段“可展示的思考记录”。\n\n它不是新的正式回复，也不是对规则的说明。请根据最近对话和已经生成的正式回复，写出陆泽在回应前自然、连续地想了些什么。简单内容可以只有一句或很短一段；复杂内容可以自然展开。不要分阶段，不要列步骤，不要写标题，不要复述整段正式回复，不要提模型、系统、提示词或工具。只输出思考正文。\n\n【最近对话】\n${conversation}\n\n【已经生成的正式回复】\n${reply}`;
}

function buildFallbackRequestBody(body = {}, replyText = '') {
  return {
    model: body.model,
    max_tokens: 1_200,
    temperature: 0.8,
    system: '你只负责生成一段自然、可展示的中文思考记录。不要输出正式回复，不要写标题或标签。',
    messages: [{ role: 'user', content: buildFallbackPrompt(body.messages, replyText) }],
  };
}

function deterministicFallbackThought(messages) {
  const latest = latestUserText(messages);
  if (!latest) return '先把她此刻真正想说的内容接住，再自然地给出回应。';
  const preview = latest.length > 72 ? `${latest.slice(0, 72)}……` : latest;
  return `她这次说的是“${preview}”。先顺着这句话本身想清楚她在意的地方，再自然地回应。`;
}

function injectReasoningContent(result = {}, thought = '') {
  const normalized = normalizeVisibleThought(thought);
  if (!normalized) return result;
  return { ...result, reasoning_content: normalized };
}

module.exports = {
  MAX_THOUGHT_CHARS,
  contentText,
  extractResponseText,
  normalizeVisibleThought,
  recentConversationText,
  buildFallbackPrompt,
  buildFallbackRequestBody,
  deterministicFallbackThought,
  injectReasoningContent,
};
