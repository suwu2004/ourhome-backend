'use strict';

// The Theater already keeps the latest raw turns in its normal context window, so
// its long-lived role/plot memory does not need a paid model refresh every couple
// of replies. Patch the refresh predicate before theaterMemoryPatch captures it:
// ordinary scenes roll forward locally and only a periodic checkpoint or a truly
// structural story event spends a background model call.
const support = require('./theaterMemorySupport');

const MAJOR_THEATER_EVENT_RE = /(?:求婚|结婚|订婚|离婚|怀孕|生子|分手|复合|和好后正式|确认(?:恋爱|伴侣|夫妻|婚姻)关系|正式(?:交往|在一起)|死亡|去世|失踪|昏迷|重伤|住院|被捕|入狱|身份(?:暴露|揭晓|公开)|真相(?:揭开|揭晓|大白)|秘密(?:曝光|揭开|坦白)|背叛|逃婚|搬家|离家出走|立下誓言|签订婚约)/u;

function shouldRefreshMemoryEconomically(memoryValue, latestUserText = '', replyText = '') {
  const memory = support.normalizeTheaterMemory(memoryValue || {});

  // Brand-new / incomplete memory still gets repaired promptly. This preserves
  // the v2 -> v3 learned-character upgrade path and deterministic fallbacks.
  if (!memory.character_anchor && !memory.plot_facts.length) return true;
  if (!memory.character_memory) return true;

  // Six successful Theater turns between ordinary checkpoints. The normal Theater
  // prompt still carries recent raw turns, so this remains inside that safety net.
  if (memory.turns_since_refresh >= 5) return true;

  // Never spend two memory-model calls on back-to-back replies. A major event that
  // happens immediately after a refresh remains in recent raw context and will be
  // folded in on the next eligible turn/checkpoint.
  if (memory.turns_since_refresh < 1) return false;

  return MAJOR_THEATER_EVENT_RE.test(`${latestUserText}\n${replyText}`);
}

support.shouldRefreshMemory = shouldRefreshMemoryEconomically;

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function theaterMemoryEconomyHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = {
        ...body,
        theater_memory_economy: 'six-turn-major-events-v1',
      };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[theater:memory:economy] express integration unavailable:', error.message);
}

module.exports = {
  MAJOR_THEATER_EVENT_RE,
  shouldRefreshMemoryEconomically,
};
