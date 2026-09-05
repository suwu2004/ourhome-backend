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
  if (!memory.character_anchor && !memory.plot_facts.length) return true;
  if (!memory.character_memory) return true;
  if (memory.turns_since_refresh >= 5) return true;
  if (memory.turns_since_refresh < 1) return false;
  return MAJOR_THEATER_EVENT_RE.test(`${latestUserText}\n${replyText}`);
}

support.shouldRefreshMemory = shouldRefreshMemoryEconomically;

// Keep the literal latest Theater exchange at the end of the provider prompt.
// This is a zero-model-cost ordering guard and does not touch persisted history.
require('./theaterLiveTurnGuardPatch');

// Rules/worldbooks are soft creative aids: after lorebook injection has assembled
// the provider body, give the Theater model explicit autonomy to select what fits.
require('./theaterPromptAutonomyPatch');

// The generator currently serializes recent raw turns into one large user prompt.
// Re-expose those turns as actual user/assistant messages immediately before the
// provider call so the model gets true conversational context, not only summaries.
require('./theaterRawTurnsPatch');

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function theaterMemoryEconomyHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, theater_memory_economy: 'six-turn-major-events-v1' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[theater:memory:economy] express integration unavailable:', error.message);
}

module.exports = { MAJOR_THEATER_EVENT_RE, shouldRefreshMemoryEconomically };