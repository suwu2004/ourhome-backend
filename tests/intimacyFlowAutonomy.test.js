const test = require('node:test');
const assert = require('node:assert/strict');

const support = require('../intimacyFlowSupport');
require('../intimacyFlowAutonomyPatch');

function config() {
  return support.normalizeConfig({
    enabled: true,
    flow: { enabled: true, minProcessTurns: 3, minRepeatProcessTurns: 1 },
    pools: [],
    cues: [
      { id: 'f', key: '前戏', kind: 'stage', flowRole: 'foreplay', enabled: true, poolIds: [] },
      { id: 'p', key: '过程', kind: 'stage', flowRole: 'process', enabled: true, poolIds: [] },
      { id: 'r', key: '复判', kind: 'stage', flowRole: 'review', enabled: true, poolIds: [] },
    ],
  });
}

test('明确停止仍然结束当前 flow', () => {
  assert.equal(support.isBoundaryStopText('停一下'), true);
  assert.equal(support.isBoundaryStopText('我不想继续了'), true);
  assert.equal(support.isBoundaryStopText('请停下来'), true);
});

test('含混或撒娇式软表达不再靠关键词机械关机', () => {
  assert.equal(support.isBoundaryStopText('算了'), false);
  assert.equal(support.isBoundaryStopText('别闹'), false);
  assert.equal(support.isBoundaryStopText('不要啦'), false);
  assert.equal(support.isBoundaryStopText('哎呀'), false);
  assert.equal(support.isBoundaryStopText('不要停'), false);
});

test('隐藏 guidance 明确把阶段选择权交给陆泽，而不是达到数字就强制推进', () => {
  const cfg = config();
  const guide = support.buildGuide(cfg, {
    active: true,
    stage: 'process',
    cycle: 1,
    stageTurn: 3,
    minProcessTurns: 3,
    minRepeatProcessTurns: 1,
    contextKeys: [],
    fixedDraws: [],
    startedAt: 1000,
  }, 'source-1', 1000);
  const body = support.injectPrivateGuidance({ system: '原提示词', messages: [] }, cfg, guide);
  const text = typeof body.system === 'string' ? body.system : body.system.map(item => item?.text || item).join('\n');
  assert.match(text, /状态机只是连续性路标，不替你做决定/);
  assert.match(text, /你保有这一轮如何继续的判断权/);
  assert.match(text, /最低轮数只防止过早跳阶段/);
  assert.match(text, /算了/);
  assert.doesNotMatch(text, /拒绝、犹豫或改变边界时，立即尊重/);
});

test('明确 stop 只结束当前 flow，后续新的真实 start 仍可重新开始', () => {
  const cfg = config();
  const active = support.buildGuide(cfg, {
    active: true,
    stage: 'process',
    cycle: 1,
    stageTurn: 2,
    minProcessTurns: 3,
    minRepeatProcessTurns: 1,
    contextKeys: [],
    fixedDraws: [],
    startedAt: 1000,
  }, 's1', 1000);
  assert.equal(support.nextGuide(cfg, { action: 'stop', keys: [] }, active, 's2', 1100), null);
  const restarted = support.nextGuide(cfg, { action: 'start', keys: [] }, null, 's3', 1200);
  assert.equal(restarted.flow.stage, 'foreplay');
  assert.equal(restarted.flow.active, true);
});
