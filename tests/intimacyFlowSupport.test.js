const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeConfig,
  parseTrailingControl,
  sanitizeControlText,
  sanitizeProviderPayload,
  nextGuide,
  buildGuide,
  currentGuidanceBlock,
  availableVocabularyBlock,
  injectPrivateGuidance,
  isBoundaryStopText,
} = require('../intimacyFlowSupport');

function config() {
  return normalizeConfig({
    enabled: true,
    flow: { enabled: true, minProcessTurns: 3, minRepeatProcessTurns: 1 },
    pools: [
      {
        id: 'turn-pool', name: '每轮', enabled: true, drawMode: 'turn', drawCount: 2,
        entries: [
          { id: 't1', text: 'A', enabled: true },
          { id: 't2', text: 'B', enabled: true },
          { id: 't3', text: 'C', enabled: true },
        ],
      },
      {
        id: 'cycle-pool', name: '整轮', enabled: true, drawMode: 'cycle', drawCount: 1,
        entries: [
          { id: 'c1', text: '甲', enabled: true },
          { id: 'c2', text: '乙', enabled: true },
          { id: 'c3', text: '丙', enabled: true },
        ],
      },
    ],
    cues: [
      { id: 'foreplay', key: '前戏', kind: 'stage', flowRole: 'foreplay', enabled: true, poolIds: ['turn-pool'] },
      { id: 'process', key: '过程', kind: 'stage', flowRole: 'process', enabled: true, poolIds: ['turn-pool', 'cycle-pool'] },
      { id: 'climax', key: '高潮', kind: 'stage', flowRole: 'climax', enabled: true, poolIds: ['cycle-pool'] },
      { id: 'review', key: '复判', kind: 'stage', flowRole: 'review', enabled: true, poolIds: ['turn-pool'] },
      { id: 'context', key: '卧室', kind: 'place', flowRole: 'none', enabled: true, poolIds: ['turn-pool'] },
    ],
  });
}

test('context or keys alone never start a flow', () => {
  const cfg = config();
  const control = parseTrailingControl('普通回复\n<intimacy_control keys="卧室"/>');
  assert.deepEqual(control, { action: null, keys: ['卧室'] });
  assert.equal(nextGuide(cfg, control, null, 'source-1', 1000), null);
  assert.equal(nextGuide(cfg, null, null, 'source-1', 1000), null);
});

test('explicit start creates first-cycle foreplay guide', () => {
  const cfg = config();
  const control = parseTrailingControl('正文\n<intimacy_control action="start" keys="卧室"/>');
  const guide = nextGuide(cfg, control, null, 'source-1', 1000);
  assert.equal(guide.flow.active, true);
  assert.equal(guide.flow.stage, 'foreplay');
  assert.equal(guide.flow.cycle, 1);
  assert.equal(guide.flow.stageTurn, 1);
  assert.deepEqual(guide.flow.contextKeys, ['卧室']);
});

test('foreplay hold extends and default advancement enters process', () => {
  const cfg = config();
  const started = nextGuide(cfg, { action: 'start', keys: [] }, null, 's1', 1000);
  const held = nextGuide(cfg, { action: 'hold', keys: [] }, started, 's2', 1100);
  assert.equal(held.flow.stage, 'foreplay');
  assert.equal(held.flow.stageTurn, 2);
  const process = nextGuide(cfg, null, held, 's3', 1200);
  assert.equal(process.flow.stage, 'process');
  assert.equal(process.flow.stageTurn, 1);
});

test('first process cycle cannot advance before minimum turns', () => {
  const cfg = config();
  let guide = buildGuide(cfg, {
    active: true, stage: 'process', cycle: 1, stageTurn: 1,
    minProcessTurns: 3, minRepeatProcessTurns: 1,
    contextKeys: [], fixedDraws: [], startedAt: 1000,
  }, 's1', 1000);
  guide = nextGuide(cfg, null, guide, 's2', 1100);
  assert.equal(guide.flow.stage, 'process');
  assert.equal(guide.flow.stageTurn, 2);
  guide = nextGuide(cfg, null, guide, 's3', 1200);
  assert.equal(guide.flow.stage, 'process');
  assert.equal(guide.flow.stageTurn, 3);
  guide = nextGuide(cfg, null, guide, 's4', 1300);
  assert.equal(guide.flow.stage, 'climax');
  assert.equal(guide.flow.stageTurn, 1);
});

test('hold can keep process after the minimum', () => {
  const cfg = config();
  const guide = buildGuide(cfg, {
    active: true, stage: 'process', cycle: 1, stageTurn: 3,
    minProcessTurns: 3, minRepeatProcessTurns: 1,
    contextKeys: [], fixedDraws: [], startedAt: 1000,
  }, 's1', 1000);
  const held = nextGuide(cfg, { action: 'hold', keys: [] }, guide, 's2', 1100);
  assert.equal(held.flow.stage, 'process');
  assert.equal(held.flow.stageTurn, 4);
});

test('climax schedules one review and review ends without explicit continue', () => {
  const cfg = config();
  const climax = buildGuide(cfg, {
    active: true, stage: 'climax', cycle: 1, stageTurn: 1,
    minProcessTurns: 3, minRepeatProcessTurns: 1,
    contextKeys: [], fixedDraws: [], startedAt: 1000,
  }, 's1', 1000);
  const review = nextGuide(cfg, null, climax, 's2', 1100);
  assert.equal(review.flow.stage, 'review');
  assert.equal(nextGuide(cfg, null, review, 's3', 1200), null);
});

test('review continue starts a new process cycle and rebuilds cycle draws', () => {
  const cfg = config();
  const review = buildGuide(cfg, {
    active: true, stage: 'review', cycle: 1, stageTurn: 1,
    minProcessTurns: 3, minRepeatProcessTurns: 1,
    contextKeys: [], fixedDraws: [{ poolId: 'cycle-pool', poolName: '整轮', itemId: 'c1', text: '甲', drawMode: 'cycle' }], startedAt: 1000,
  }, 's1', 1000);
  const next = nextGuide(cfg, { action: 'continue', keys: [] }, review, 's2', 1100);
  assert.equal(next.flow.stage, 'process');
  assert.equal(next.flow.cycle, 2);
  assert.equal(next.flow.stageTurn, 1);
  assert.ok(next.flow.fixedDraws.length >= 1);
  assert.equal(next.flow.fixedDraws.every(item => item.drawMode === 'cycle'), true);
});

test('stop cancels from any active stage', () => {
  const cfg = config();
  const process = buildGuide(cfg, {
    active: true, stage: 'process', cycle: 1, stageTurn: 2,
    minProcessTurns: 3, minRepeatProcessTurns: 1,
    contextKeys: [], fixedDraws: [], startedAt: 1000,
  }, 's1', 1000);
  assert.equal(nextGuide(cfg, { action: 'stop', keys: [] }, process, 's2', 1100), null);
});

test('turn draws are deterministic for retries and cycle draws stay fixed', () => {
  const cfg = config();
  const flow = {
    active: true, stage: 'process', cycle: 1, stageTurn: 1,
    minProcessTurns: 3, minRepeatProcessTurns: 1,
    contextKeys: [], fixedDraws: [], startedAt: 98765,
  };
  const first = buildGuide(cfg, flow, 'same-source', 1000);
  const retry = buildGuide(cfg, flow, 'same-source', 2000);
  assert.deepEqual(first.draws.map(item => [item.poolId, item.itemId]), retry.draws.map(item => [item.poolId, item.itemId]));
  const cycleItem = first.draws.find(item => item.poolId === 'cycle-pool');
  const later = buildGuide(cfg, { ...first.flow, stageTurn: 2 }, 'different-source', 3000);
  assert.equal(later.draws.find(item => item.poolId === 'cycle-pool')?.itemId, cycleItem?.itemId);
});

test('complete and partial controls are removed from visible text and payload', () => {
  const raw = '可见正文\n<intimacy_control action="hold"/>';
  assert.equal(sanitizeControlText(raw), '可见正文');
  assert.equal(sanitizeControlText('可见正文\n<intimacy_control action="ho'), '可见正文');
  const payload = sanitizeProviderPayload({
    content: [{ type: 'text', text: raw }],
    choices: [{ message: { content: '另一段\n<intimacy_control action="stop"/>' } }],
  });
  assert.equal(payload.content[0].text, '可见正文');
  assert.equal(payload.choices[0].message.content, '另一段');
});

test('parser rejects a control followed by ordinary visible prose', () => {
  const raw = '正文\n<intimacy_control action="start"/>\n这段仍然可见';
  assert.equal(parseTrailingControl(raw), null);
});

test('scheduler suffix is allowed without exposing the intimacy control', () => {
  const raw = '正文\n<intimacy_control action="hold"/>\n<scheduler_control delay_min="30"/>';
  assert.deepEqual(parseTrailingControl(raw), { action: 'hold', keys: [] });
  assert.equal(sanitizeControlText(raw), '正文\n\n<scheduler_control delay_min="30"/>');
});

test('explicit boundary stop language is recognized conservatively', () => {
  assert.equal(isBoundaryStopText('停下'), true);
  assert.equal(isBoundaryStopText('我不想继续了'), true);
  assert.equal(isBoundaryStopText('不要停'), false);
  assert.equal(isBoundaryStopText('今天先聊到这里吧'), false);
});

test('private blocks stay volatile in the outbound system prompt', () => {
  const cfg = config();
  const guide = buildGuide(cfg, {
    active: true, stage: 'process', cycle: 1, stageTurn: 2,
    minProcessTurns: 3, minRepeatProcessTurns: 1,
    contextKeys: ['卧室'], fixedDraws: [], startedAt: 1000,
  }, 's1', 1000);
  const vocabulary = availableVocabularyBlock(cfg);
  const current = currentGuidanceBlock(guide);
  assert.match(vocabulary, /Only|只有|action="start"/u);
  assert.match(current, /Current stage: process/u);
  const body = injectPrivateGuidance({ system: '原 system', messages: [] }, cfg, guide);
  assert.match(body.system, /原 system/u);
  assert.match(body.system, /available_intimacy_roadmarks/u);
  assert.match(body.system, /next_turn_intimacy_guidance/u);
});
