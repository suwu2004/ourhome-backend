const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldRefreshMemoryEconomically,
  MAJOR_THEATER_EVENT_RE,
} = require('../theaterMemoryEconomyPatch');

function stableMemory(turns = 0) {
  return {
    character_anchor: '稳定角色锚点',
    character_memory: '已经建立角色长期记忆',
    plot_facts: ['既有剧情事实'],
    turns_since_refresh: turns,
  };
}

test('ordinary Theater scenes checkpoint every sixth successful turn', () => {
  for (let turns = 0; turns < 5; turns += 1) {
    assert.equal(
      shouldRefreshMemoryEconomically(stableMemory(turns), '一起喝茶', '他把茶杯推过来。'),
      false,
    );
  }
  assert.equal(
    shouldRefreshMemoryEconomically(stableMemory(5), '一起喝茶', '他把茶杯推过来。'),
    true,
  );
});

test('common roleplay beats do not spend an immediate memory-model call', () => {
  for (const scene of ['他回来以后亲吻了我', '我们争吵后道歉', '第一次一起看雪', '我答应陪他散步']) {
    assert.equal(MAJOR_THEATER_EVENT_RE.test(scene), false, scene);
    assert.equal(shouldRefreshMemoryEconomically(stableMemory(2), scene, '剧情继续。'), false, scene);
  }
});

test('structural relationship or life events refresh early but never back-to-back', () => {
  assert.equal(MAJOR_THEATER_EVENT_RE.test('他向我求婚，我们决定结婚'), true);
  assert.equal(
    shouldRefreshMemoryEconomically(stableMemory(0), '他向我求婚，我们决定结婚', '剧情继续。'),
    false,
  );
  assert.equal(
    shouldRefreshMemoryEconomically(stableMemory(1), '他向我求婚，我们决定结婚', '剧情继续。'),
    true,
  );
});

test('brand-new or incomplete Theater memory is still repaired immediately', () => {
  assert.equal(shouldRefreshMemoryEconomically({ character_anchor: '', plot_facts: [] }, '', ''), true);
  assert.equal(
    shouldRefreshMemoryEconomically({ character_anchor: '稳定', plot_facts: ['事实'], character_memory: '' }, '普通聊天', '普通回复'),
    true,
  );
});
