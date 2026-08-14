const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_ACTIVE_FACTS,
  FORCE_COMPACTION_AT,
  isNearDuplicateFact,
  compactTheaterFacts,
  patchedMergeTheaterFacts,
  patchedShouldRefreshMemory,
} = require('../theaterMemoryFactDedupPatch');

test('nearby repeated scene summaries collapse into one richer fact', () => {
  const first = '陆泽去西窗梳妆台取来檀木梳与素银簪，指导叶檀坐下，耐心为她拆发梳顺并盘出端正的随云小髻。';
  const repeated = '陆泽取来檀木梳与素银簪子，极为耐心地替叶檀梳顺长发，挽起端正的随云小髻并插好银簪。';
  assert.equal(isNearDuplicateFact(first, repeated, 2), true);
  const compacted = compactTheaterFacts([first, '两人喝了温茶。', repeated]);
  assert.equal(compacted.length, 2);
  assert.ok(compacted.some(item => item.includes('随云小髻')));
});

test('different events in the same scene stay separate', () => {
  const door = '陆泽听到巷子外熟悉的脚步声靠近，判断陆清欢已经走到门外。';
  const tea = '陆泽让叶檀将温好的茶水端入堂屋，准备就着陆清欢带回的热黄米糕一同食用。';
  assert.equal(isNearDuplicateFact(door, tea, 1), false);
  assert.deepEqual(compactTheaterFacts([door, tea]), [door, tea]);
});

test('patched merge frees duplicate slots and keeps a bounded active fact set', () => {
  const repeatedA = '陆泽接过叶檀手中的陶茶壶，暗中检查确认其手指未被烫伤。';
  const repeatedB = '陆泽跟进堂屋接过叶檀手中的陶茶壶，暗中确认她的手没有被灶火烫伤。';
  const previous = Array.from({ length: 53 }, (_, index) => `独立剧情事实 ${index + 1}：发生了一件不会与其他条目重复的事情。`);
  previous.push(repeatedA);
  const merged = patchedMergeTheaterFacts(previous, [repeatedB, '新的独立剧情事实：两人准备出门。'], 60);
  assert.ok(merged.length <= MAX_ACTIVE_FACTS);
  assert.equal(merged.filter(item => item.includes('陶茶壶')).length, 1);
  assert.match(merged.at(-1), /准备出门/);
});

test('bloated legacy memories request one immediate compaction refresh', () => {
  const memory = {
    character_anchor: '稳定',
    plot_facts: Array.from({ length: FORCE_COMPACTION_AT }, (_, index) => `事实 ${index}`),
    turns_since_refresh: 0,
  };
  assert.equal(patchedShouldRefreshMemory(memory, '普通聊天', '普通回复'), true);
});
