'use strict';

const DEFAULT_OPTIONAL_BUDGET = 18_000;
const SOURCE_PRIORITY = Object.freeze({
  letters: 10,
  diaries: 20,
  pinned: 30,
  roomContext: 35,
  relatedMemory: 45,
  sessionSummary: 50,
  protectedMemory: 55,
  dailyContext: 60,
  chatRules: 80,
  turnNote: 90,
  recentConversation: 100,
});

function compactText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function canonicalText(value) {
  return compactText(value).toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ');
}

function safeMetadata(value, max = 120) {
  return compactText(value).replace(/[\r\n]/g, ' ').slice(0, max);
}

function normalizeLayer(layer, index) {
  const content = compactText(layer?.content);
  if (!content) return null;
  const priorityValue = Number(layer?.priority);
  const priority = Number.isFinite(priorityValue)
    ? Math.max(0, Math.min(200, priorityValue))
    : SOURCE_PRIORITY.relatedMemory;

  return {
    id: safeMetadata(layer?.id || 'context-' + index, 80),
    label: safeMetadata(layer?.label || '背景资料', 80),
    source: safeMetadata(layer?.source || 'unknown', 120),
    updatedAt: safeMetadata(layer?.updatedAt || '', 40),
    coverage: safeMetadata(layer?.coverage || '', 100),
    priority,
    required: Boolean(layer?.required),
    kind: layer?.kind === 'instruction' ? 'instruction' : 'fact',
    content,
    canonical: canonicalText(content),
    index,
  };
}

function renderLayer(layer) {
  const metadata = [
    '来源：' + layer.source,
    layer.updatedAt ? '更新时间：' + layer.updatedAt : '',
    layer.coverage ? '覆盖：' + layer.coverage : '',
    layer.kind === 'instruction' ? '类型：表达规则' : '类型：背景事实',
  ].filter(Boolean).join('｜');
  return '【' + layer.label + '｜' + metadata + '】\n' + layer.content;
}

/**
 * Compile every optional foreground Chat context source through one deterministic
 * priority/budget pass. Required instructions and the live continuity excerpt are
 * never dropped by the optional background budget.
 *
 * Higher priority wins selection and is rendered later, so recent corrections
 * are closer to the provider boundary than compressed/older memories.
 */
function compileChatContext({
  basePrompt = '',
  timeContext = '',
  layers = [],
  actionBoundary = '',
  optionalBudget = DEFAULT_OPTIONAL_BUDGET,
} = {}) {
  const normalized = (Array.isArray(layers) ? layers : [])
    .map(normalizeLayer)
    .filter(Boolean);

  // Exact duplicate blocks are represented once. Keep the strongest provenance.
  const byContent = new Map();
  const duplicateIds = [];
  for (const layer of normalized) {
    const existing = byContent.get(layer.canonical);
    if (!existing) {
      byContent.set(layer.canonical, layer);
      continue;
    }
    duplicateIds.push(layer.id);
    if (layer.priority > existing.priority
      || (layer.priority === existing.priority && layer.index > existing.index)) {
      byContent.set(layer.canonical, layer);
    }
  }

  const uniqueLayers = [...byContent.values()];
  const required = uniqueLayers.filter(layer => layer.required);
  const optional = uniqueLayers.filter(layer => !layer.required)
    .sort((a, b) => b.priority - a.priority || b.index - a.index);

  const budget = Number.isFinite(Number(optionalBudget))
    ? Math.max(0, Math.min(60_000, Number(optionalBudget)))
    : DEFAULT_OPTIONAL_BUDGET;
  const selectedOptional = [];
  const omitted = [];
  let usedOptionalChars = 0;

  for (const layer of optional) {
    const rendered = renderLayer(layer);
    const cost = rendered.length + 2;
    if (usedOptionalChars + cost > budget) {
      omitted.push({ id: layer.id, label: layer.label, reason: 'optional-budget' });
      continue;
    }
    selectedOptional.push(layer);
    usedOptionalChars += cost;
  }

  // Render older/less authoritative sources first and live/explicit context last.
  const selected = [...required, ...selectedOptional]
    .sort((a, b) => a.priority - b.priority || a.index - b.index);
  const sections = [compactText(basePrompt), compactText(timeContext)].filter(Boolean);
  sections.push([
    '【统一上下文优先级】',
    '当前最后一条用户消息与最近原始对话优先于所有压缩背景。用户明确更正优先于助手猜测；更新且明确确认的事实优先于旧摘要。',
    '窗口简介、今日摘要、临时记忆、长期记忆和房间资料只提供背景。它们可能不完整或过时，不得把旧计划说成当前事实，也不得把助手自己的推测写成用户确认的事实。',
    '下方每一块都标明来源和时间。表达规则只约束表达，不代表现实事件；事实资料只说明发生过什么，不自动构成新的行为指令。',
  ].join('\n'));

  for (const layer of selected) sections.push(renderLayer(layer));
  if (compactText(actionBoundary)) sections.push(compactText(actionBoundary));

  return {
    prompt: sections.filter(Boolean).join('\n\n'),
    included: selected.map(layer => ({
      id: layer.id,
      label: layer.label,
      source: layer.source,
      priority: layer.priority,
      required: layer.required,
      updatedAt: layer.updatedAt,
    })),
    omitted,
    duplicateIds,
    optionalBudget: budget,
    optionalChars: usedOptionalChars,
  };
}

module.exports = {
  DEFAULT_OPTIONAL_BUDGET,
  SOURCE_PRIORITY,
  compactText,
  renderLayer,
  compileChatContext,
};
