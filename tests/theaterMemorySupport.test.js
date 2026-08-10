'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTheaterMemory, mergeTheaterFacts, buildMemoryPromptBlock } = require('../theaterMemorySupport');

test('theater memory v2 preserves a deeper event history', () => {
  const facts = Array.from({ length: 70 }, (_, index) => `剧情事实 ${index + 1}`);
  const memory = normalizeTheaterMemory({ plot_facts: facts });
  assert.equal(memory.version, 2);
  assert.equal(memory.plot_facts.length, 60);
  assert.equal(memory.plot_facts[0], '剧情事实 1');
  assert.equal(memory.plot_facts.at(-1), '剧情事实 60');
});

test('incremental theater facts merge without deleting old unique events', () => {
  const merged = mergeTheaterFacts(['第一次见面是在雨夜', '答应会回来'], ['答应会回来', '一起搬进新家'], 60);
  assert.deepEqual(merged, ['第一次见面是在雨夜', '答应会回来', '一起搬进新家']);
});

test('memory prompt separates archived and recent plot facts', () => {
  const facts = Array.from({ length: 45 }, (_, index) => `事件 ${index + 1}`);
  const prompt = buildMemoryPromptBlock({ plot_facts: facts });
  assert.match(prompt, /长期事件档案/);
  assert.match(prompt, /近期核心剧情事实/);
  assert.match(prompt, /事件 1/);
  assert.match(prompt, /事件 45/);
});
