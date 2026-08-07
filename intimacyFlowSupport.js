'use strict';

const crypto = require('crypto');

const MAX_POOLS = 80;
const MAX_CUES = 80;
const MAX_ENTRIES_PER_POOL = 160;
const MAX_ENTRY_CHARS = 1200;
const MAX_CONTEXT_KEYS = 4;
const MAX_COMPOSITE_DRAWS = 12;
const MAX_GUIDANCE_CHARS = 8000;
const FLOW_ROLES = new Set(['none', 'foreplay', 'process', 'climax', 'review']);
const CUE_KINDS = new Set(['stage', 'place', 'other']);
const CONTROL_ACTIONS = new Set(['start', 'hold', 'continue', 'stop']);

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function compactLine(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function escapePrivateText(value, max = MAX_ENTRY_CHARS) {
  return compactLine(value, max).replace(/</g, '‹').replace(/>/g, '›');
}

function normalizeKey(value) {
  return compactLine(value, 80).toLocaleLowerCase('zh-CN');
}

function normalizeConfig(raw = {}) {
  const sourcePools = Array.isArray(raw.pools) ? raw.pools.slice(0, MAX_POOLS) : [];
  const pools = [];
  const poolIds = new Set();

  for (let index = 0; index < sourcePools.length; index += 1) {
    const source = sourcePools[index] || {};
    let id = compactLine(source.id, 80) || `pool-${index + 1}`;
    if (poolIds.has(id)) id = `${id}-${index + 1}`;
    poolIds.add(id);

    const entries = [];
    const entryIds = new Set();
    for (let entryIndex = 0; entryIndex < (Array.isArray(source.entries) ? source.entries.length : 0) && entries.length < MAX_ENTRIES_PER_POOL; entryIndex += 1) {
      const item = source.entries[entryIndex] || {};
      const text = escapePrivateText(item.text, MAX_ENTRY_CHARS);
      if (!text) continue;
      let entryId = compactLine(item.id, 100) || `${id}-entry-${entryIndex + 1}`;
      if (entryIds.has(entryId)) entryId = `${entryId}-${entryIndex + 1}`;
      entryIds.add(entryId);
      entries.push({ id: entryId, text, enabled: item.enabled !== false });
    }

    pools.push({
      id,
      name: escapePrivateText(source.name || id, 120),
      enabled: source.enabled !== false,
      drawMode: source.drawMode === 'cycle' ? 'cycle' : 'turn',
      drawCount: clampInt(source.drawCount, 1, 5, 1),
      entries,
    });
  }

  const validPoolIds = new Set(pools.map(pool => pool.id));
  const cues = [];
  const cueKeys = new Set();
  for (let index = 0; index < (Array.isArray(raw.cues) ? raw.cues.length : 0) && cues.length < MAX_CUES; index += 1) {
    const source = raw.cues[index] || {};
    const key = escapePrivateText(source.key, 80);
    const normalizedKey = normalizeKey(key);
    if (!key || cueKeys.has(normalizedKey)) continue;
    cueKeys.add(normalizedKey);
    const poolIdsForCue = [...new Set((Array.isArray(source.poolIds) ? source.poolIds : [])
      .map(item => compactLine(item, 80))
      .filter(id => validPoolIds.has(id)))];
    cues.push({
      id: compactLine(source.id, 100) || `cue-${index + 1}`,
      key,
      kind: CUE_KINDS.has(source.kind) ? source.kind : 'other',
      flowRole: FLOW_ROLES.has(source.flowRole) ? source.flowRole : 'none',
      description: escapePrivateText(source.description, 300),
      enabled: source.enabled !== false,
      poolIds: poolIdsForCue,
    });
  }

  return {
    schemaVersion: 1,
    enabled: raw.enabled !== false,
    flow: {
      enabled: raw.flow?.enabled !== false,
      minProcessTurns: clampInt(raw.flow?.minProcessTurns, 3, 12, 3),
      minRepeatProcessTurns: clampInt(raw.flow?.minRepeatProcessTurns, 1, 12, 1),
    },
    pools,
    cues,
  };
}

function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string' || typeof content === 'number') return String(content);
  if (Array.isArray(content)) {
    return content.map(block => {
      if (typeof block === 'string') return block;
      if (!block || typeof block !== 'object') return '';
      return contentText(block.text ?? block.content ?? block.value ?? '');
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') return contentText(content.text ?? content.content ?? content.value ?? '');
  return '';
}

function systemText(system) {
  return contentText(system);
}

function isMainChatRequest(url, body = {}) {
  if (!/\/messages(?:\?|$)/i.test(String(url || ''))) return false;
  const text = systemText(body.system);
  return text.includes('【回复长度】')
    && text.includes('【OurHome 房间与入口认知（事实规则）】');
}

function latestUserText(messages = []) {
  const rows = Array.isArray(messages) ? messages : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.role !== 'user') continue;
    const text = contentText(rows[index]?.content).trim();
    if (text) return text;
  }
  return '';
}

function isBoundaryStopText(value) {
  const text = compactLine(value, 220).toLocaleLowerCase('zh-CN');
  if (!text) return false;
  if (/^(?:停|停下|暂停|先停|不要了|不继续了|别继续了|到这里|结束|stop|pause)[！!。.?？\s]*$/iu.test(text)) return true;
  return /(?:我不想继续|我不愿意继续|别再继续|现在不要继续|请停下来|马上停下)/u.test(text);
}

function parseAttrs(raw = '') {
  const attrs = {};
  const pattern = /([a-zA-Z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(raw))) attrs[match[1]] = match[2] ?? match[3] ?? '';
  return attrs;
}

function splitControlKeys(value) {
  const list = String(value || '').split(/[|｜]/).map(item => compactLine(item, 80)).filter(Boolean);
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const normalized = normalizeKey(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(item);
    if (result.length >= MAX_CONTEXT_KEYS) break;
  }
  return result;
}

function supportedControlSuffix(value) {
  const suffix = String(value || '').trim();
  if (!suffix) return true;
  return /^(?:(?:<scheduler_control\b[^<>]*\/>|<external_flow_control\b[^<>]*\/>)[\s\r\n]*)+$/i.test(suffix);
}

function parseTrailingControl(raw) {
  const text = String(raw || '');
  const matches = [];
  const pattern = /<intimacy_control\b([^<>]*?)\/>/gi;
  let match;
  while ((match = pattern.exec(text))) matches.push({ match, start: match.index, end: pattern.lastIndex });
  if (!matches.length) return null;
  const candidate = matches[matches.length - 1];
  if (!supportedControlSuffix(text.slice(candidate.end))) return null;
  const attrs = parseAttrs(candidate.match[1]);
  const action = CONTROL_ACTIONS.has(String(attrs.action || '').toLowerCase())
    ? String(attrs.action).toLowerCase()
    : null;
  const keys = splitControlKeys(attrs.keys);
  if (!action && !keys.length) return null;
  return { action, keys };
}

function sanitizeControlText(raw) {
  return String(raw ?? '')
    .replace(/<intimacy_control\b[^<>]*\/>/gi, '')
    .replace(/(?:\r?\n)?<intimacy_control\b[^\r\n<>]*$/gi, '')
    .trimEnd();
}

function responseText(payload = {}) {
  if (typeof payload.content === 'string') return payload.content;
  if (Array.isArray(payload.content)) {
    const text = payload.content
      .filter(block => !block?.type || block.type === 'text' || block.type === 'output_text')
      .map(block => contentText(block))
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  for (const choice of Array.isArray(payload.choices) ? payload.choices : []) {
    const text = contentText(choice?.message?.content ?? choice?.delta?.content ?? choice?.text);
    if (text) return text;
  }
  return contentText(payload.text ?? payload.output_text ?? payload.message?.content ?? '');
}

function sanitizeContentValue(value) {
  if (typeof value === 'string') return sanitizeControlText(value);
  if (!Array.isArray(value)) return value;
  return value.map(block => {
    if (typeof block === 'string') return sanitizeControlText(block);
    if (!block || typeof block !== 'object') return block;
    if (typeof block.text === 'string') return { ...block, text: sanitizeControlText(block.text) };
    if (typeof block.content === 'string' && (!block.type || ['text', 'output_text'].includes(block.type))) {
      return { ...block, content: sanitizeControlText(block.content) };
    }
    return block;
  });
}

function sanitizeProviderPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const next = { ...payload };
  if (next.content !== undefined) next.content = sanitizeContentValue(next.content);
  if (typeof next.text === 'string') next.text = sanitizeControlText(next.text);
  if (typeof next.output_text === 'string') next.output_text = sanitizeControlText(next.output_text);
  if (next.message && typeof next.message === 'object' && next.message.content !== undefined) {
    next.message = { ...next.message, content: sanitizeContentValue(next.message.content) };
  }
  if (Array.isArray(next.choices)) {
    next.choices = next.choices.map(choice => {
      if (!choice || typeof choice !== 'object') return choice;
      const updated = { ...choice };
      if (typeof updated.text === 'string') updated.text = sanitizeControlText(updated.text);
      if (updated.message && typeof updated.message === 'object' && updated.message.content !== undefined) {
        updated.message = { ...updated.message, content: sanitizeContentValue(updated.message.content) };
      }
      if (updated.delta && typeof updated.delta === 'object' && updated.delta.content !== undefined) {
        updated.delta = { ...updated.delta, content: sanitizeContentValue(updated.delta.content) };
      }
      return updated;
    });
  }
  return next;
}

function hasToolUse(payload = {}) {
  if (String(payload.stop_reason || '').toLowerCase().includes('tool')) return true;
  if ((Array.isArray(payload.content) ? payload.content : []).some(block => /tool_(?:use|call)/i.test(String(block?.type || '')))) return true;
  return (Array.isArray(payload.choices) ? payload.choices : []).some(choice => {
    if (/tool/i.test(String(choice?.finish_reason || ''))) return true;
    return Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0;
  });
}

function stableHash(value) {
  const digest = crypto.createHash('sha256').update(String(value)).digest();
  return digest.readUInt32BE(0);
}

function deterministicDraw(pool, seedBase) {
  const candidates = pool.entries.filter(entry => entry.enabled !== false && entry.text);
  const remaining = [...candidates];
  const selected = [];
  const count = Math.min(pool.drawCount, remaining.length);
  for (let drawIndex = 0; drawIndex < count; drawIndex += 1) {
    const index = stableHash(`${seedBase}\0${pool.id}\0${drawIndex}`) % remaining.length;
    const [entry] = remaining.splice(index, 1);
    selected.push({ poolId: pool.id, poolName: pool.name, itemId: entry.id, text: entry.text, drawMode: pool.drawMode });
  }
  return selected;
}

function cueByRole(config, role) {
  return config.cues.find(cue => cue.enabled && cue.kind === 'stage' && cue.flowRole === role) || null;
}

function validContextKeys(config, keys = []) {
  const cueMap = new Map(config.cues.filter(cue => cue.enabled && cue.kind !== 'stage').map(cue => [normalizeKey(cue.key), cue.key]));
  const result = [];
  for (const key of Array.isArray(keys) ? keys : []) {
    const canonical = cueMap.get(normalizeKey(key));
    if (canonical && !result.includes(canonical)) result.push(canonical);
    if (result.length >= MAX_CONTEXT_KEYS) break;
  }
  return result;
}

function activePools(config, flow) {
  const selectedIds = [];
  const pushCuePools = cue => {
    if (!cue?.enabled) return;
    for (const poolId of cue.poolIds || []) if (!selectedIds.includes(poolId)) selectedIds.push(poolId);
  };
  const contextMap = new Map(config.cues.filter(cue => cue.enabled).map(cue => [normalizeKey(cue.key), cue]));
  for (const key of flow.contextKeys || []) pushCuePools(contextMap.get(normalizeKey(key)));
  pushCuePools(cueByRole(config, flow.stage));
  const poolMap = new Map(config.pools.map(pool => [pool.id, pool]));
  return selectedIds.map(id => poolMap.get(id)).filter(pool => pool?.enabled && pool.entries.some(entry => entry.enabled && entry.text));
}

function normalizeFixedDraws(value = []) {
  return (Array.isArray(value) ? value : []).map(item => ({
    poolId: compactLine(item?.poolId, 80),
    poolName: escapePrivateText(item?.poolName, 120),
    itemId: compactLine(item?.itemId, 100),
    text: escapePrivateText(item?.text, MAX_ENTRY_CHARS),
    drawMode: 'cycle',
  })).filter(item => item.poolId && item.itemId && item.text).slice(0, MAX_COMPOSITE_DRAWS);
}

function buildGuide(configInput, flowInput, sourceKey, now = Date.now()) {
  const config = normalizeConfig(configInput);
  const flow = {
    active: true,
    stage: FLOW_ROLES.has(flowInput?.stage) && flowInput.stage !== 'none' ? flowInput.stage : 'foreplay',
    cycle: clampInt(flowInput?.cycle, 1, 999, 1),
    stageTurn: clampInt(flowInput?.stageTurn, 1, 999, 1),
    minProcessTurns: clampInt(flowInput?.minProcessTurns, 3, 12, config.flow.minProcessTurns),
    minRepeatProcessTurns: clampInt(flowInput?.minRepeatProcessTurns, 1, 12, config.flow.minRepeatProcessTurns),
    contextKeys: validContextKeys(config, flowInput?.contextKeys || []),
    fixedDraws: normalizeFixedDraws(flowInput?.fixedDraws || []),
    startedAt: Number(flowInput?.startedAt) || Number(now) || Date.now(),
  };

  const draws = [];
  const fixedByPool = new Map();
  for (const item of flow.fixedDraws) {
    if (!fixedByPool.has(item.poolId)) fixedByPool.set(item.poolId, []);
    fixedByPool.get(item.poolId).push(item);
  }

  for (const pool of activePools(config, flow)) {
    let selected;
    if (pool.drawMode === 'cycle') {
      selected = fixedByPool.get(pool.id) || [];
      if (!selected.length) {
        selected = deterministicDraw(pool, `${flow.startedAt}\0cycle:${flow.cycle}`);
        flow.fixedDraws.push(...selected.map(item => ({ ...item, drawMode: 'cycle' })));
      }
    } else {
      selected = deterministicDraw(pool, String(sourceKey ?? now));
    }
    for (const item of selected) {
      if (draws.length >= MAX_COMPOSITE_DRAWS) break;
      draws.push(item);
    }
    if (draws.length >= MAX_COMPOSITE_DRAWS) break;
  }

  const stageCue = cueByRole(config, flow.stage);
  const labelParts = [...flow.contextKeys, stageCue?.key].filter(Boolean);
  return {
    schemaVersion: 1,
    status: 'pending',
    sourceMessageId: String(sourceKey ?? ''),
    consumedByUserMessageId: null,
    keys: [...flow.contextKeys],
    label: labelParts.join('-') || flow.stage,
    draws,
    createdAt: Number(now) || Date.now(),
    flow,
  };
}

function inactiveState(now = Date.now()) {
  return {
    schemaVersion: 1,
    status: 'inactive',
    sourceMessageId: '',
    consumedByUserMessageId: null,
    keys: [],
    label: '',
    draws: [],
    createdAt: Number(now) || Date.now(),
    flow: { active: false },
  };
}

function nextGuide(configInput, rawControl, appliedGuide, sourceKey, now = Date.now()) {
  const config = normalizeConfig(configInput);
  if (!config.enabled || !config.flow.enabled) return null;
  const control = rawControl || null;

  if (appliedGuide?.flow?.active) {
    if (control?.action === 'stop') return null;
    return advanceFlow(config, appliedGuide, control, sourceKey, now);
  }

  if (!control || control.action !== 'start') return null;
  const flow = {
    active: true,
    stage: 'foreplay',
    cycle: 1,
    stageTurn: 1,
    minProcessTurns: config.flow.minProcessTurns,
    minRepeatProcessTurns: config.flow.minRepeatProcessTurns,
    contextKeys: validContextKeys(config, control.keys),
    fixedDraws: [],
    startedAt: Number(now) || Date.now(),
  };
  return buildGuide(config, flow, sourceKey, now);
}

function advanceFlow(configInput, appliedGuide, control, sourceKey, now = Date.now()) {
  const config = normalizeConfig(configInput);
  const flow = {
    ...appliedGuide.flow,
    contextKeys: [...(appliedGuide.flow?.contextKeys || [])],
    fixedDraws: normalizeFixedDraws(appliedGuide.flow?.fixedDraws || []),
  };
  if (control?.keys?.length) flow.contextKeys = validContextKeys(config, control.keys);

  if (flow.stage === 'foreplay') {
    if (control?.action === 'hold') flow.stageTurn += 1;
    else {
      flow.stage = 'process';
      flow.stageTurn = 1;
    }
  } else if (flow.stage === 'process') {
    const minimum = flow.cycle === 1 ? flow.minProcessTurns : flow.minRepeatProcessTurns;
    if (flow.stageTurn < minimum || control?.action === 'hold') flow.stageTurn += 1;
    else {
      flow.stage = 'climax';
      flow.stageTurn = 1;
    }
  } else if (flow.stage === 'climax') {
    flow.stage = 'review';
    flow.stageTurn = 1;
  } else if (flow.stage === 'review') {
    if (control?.action !== 'continue') return null;
    flow.stage = 'process';
    flow.cycle += 1;
    flow.stageTurn = 1;
    flow.fixedDraws = [];
  } else {
    return null;
  }

  return buildGuide(config, flow, sourceKey, now);
}

function availableVocabularyBlock(configInput) {
  const config = normalizeConfig(configInput);
  const cues = config.cues.filter(cue => cue.enabled);
  if (!config.enabled || !config.flow.enabled || !cues.length) return '';
  const lines = cues.map(cue => `- ${cue.key} (${cue.kind}; role=${cue.flowRole})${cue.description ? `：${cue.description}` : ''}`);
  return `<available_intimacy_roadmarks>\n这些是后台私有的连续互动路标，只用于状态选择，不是触发关键词。\n地点、洗澡、身体状态、气氛、撒娇、暧昧、试探、单独出现的阶段词，都不能启动流程。\n只有当你这一轮可见回复本身已经真实进入对应的成人亲密互动，并且你确认适合连续推进时，才在可见正文结束后单独输出：<intimacy_control action="start" keys="可选上下文路标"/>。\n如果没有真实进入，不输出任何 intimacy_control。keys 只提供上下文，不能单独启动。\n用户任何停止、暂停、拒绝或边界变化都优先于流程。\n所有 intimacy_control 都是隐藏协议，不要解释、不要引用。\n\n${lines.join('\n')}\n</available_intimacy_roadmarks>`;
}

function currentGuidanceBlock(guide) {
  if (!guide?.flow?.active) return '';
  const flow = guide.flow;
  const minimum = flow.stage === 'process'
    ? (flow.cycle === 1 ? flow.minProcessTurns : flow.minRepeatProcessTurns)
    : null;
  const drawLines = (guide.draws || []).map(item => `- [${item.poolName || item.poolId}] ${item.text}`);
  const instructions = [
    '这是后台私有连续互动状态，不要在可见回复中解释或引用。',
    '用户停止、暂停、拒绝、犹豫或改变边界时，立即尊重并在正文末尾输出隐藏 action="stop"。',
    flow.stage === 'foreplay' || flow.stage === 'process'
      ? '如果当前阶段自然需要继续一轮，在正文末尾输出隐藏 action="hold"；否则不写 hold，让状态机按最低轮数规则自然推进。'
      : '',
    flow.stage === 'review'
      ? '只有当双方在可见互动中明确继续时，才在正文末尾输出隐藏 action="continue"；否则不输出 continue，流程会保守结束。'
      : '',
    '隐藏控制必须独占最后一行，格式只能是 <intimacy_control action="hold|continue|stop" keys="可选上下文"/>；不要把控制写进正文。',
    '抽到的词只是创作锚点，不是清单、上限或强制动作；自然使用即可。',
  ].filter(Boolean);
  const raw = `<next_turn_intimacy_guidance roadmark="${escapePrivateText(guide.label, 180)}">\nCurrent cycle: ${flow.cycle}\nCurrent stage: ${flow.stage}\nCurrent stage turn: ${flow.stageTurn}${minimum ? `\nMinimum process turns: ${minimum}` : ''}\n\n${instructions.join('\n')}\n\n${drawLines.join('\n')}\n</next_turn_intimacy_guidance>`;
  return raw.slice(0, MAX_GUIDANCE_CHARS);
}

function appendSystemBlock(system, block) {
  if (!block) return system;
  if (typeof system === 'string') return `${system.trimEnd()}\n\n${block}`;
  if (Array.isArray(system)) return [...system, { type: 'text', text: block }];
  return block;
}

function injectPrivateGuidance(body = {}, config, guide = null) {
  const vocab = availableVocabularyBlock(config);
  const current = currentGuidanceBlock(guide);
  const block = [vocab, current].filter(Boolean).join('\n\n');
  if (!block) return body;
  return { ...body, system: appendSystemBlock(body.system, block) };
}

module.exports = {
  MAX_POOLS,
  MAX_CUES,
  MAX_ENTRIES_PER_POOL,
  MAX_CONTEXT_KEYS,
  MAX_COMPOSITE_DRAWS,
  MAX_GUIDANCE_CHARS,
  clampInt,
  compactLine,
  normalizeKey,
  normalizeConfig,
  contentText,
  systemText,
  latestUserText,
  isBoundaryStopText,
  isMainChatRequest,
  parseTrailingControl,
  sanitizeControlText,
  sanitizeProviderPayload,
  responseText,
  hasToolUse,
  stableHash,
  deterministicDraw,
  validContextKeys,
  buildGuide,
  inactiveState,
  nextGuide,
  advanceFlow,
  availableVocabularyBlock,
  currentGuidanceBlock,
  injectPrivateGuidance,
};
