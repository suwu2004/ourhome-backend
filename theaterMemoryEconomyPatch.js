'use strict';

// Theater already keeps the latest raw turns in its normal context window, so
// long-lived role/plot memory does not need a paid model refresh every reply.
// This module ONLY decides when a memory checkpoint is worthwhile. Prompt
// assembly and continuity are intentionally owned by theaterRawTurnsPatch so
// there is one source of truth instead of several overlapping fetch wrappers.
const support = require('./theaterMemorySupport');

const MAJOR_THEATER_EVENT_RE = /(?:求婚|结婚|订婚|离婚|怀孕|生子|分手|复合|和好后正式|确认(?:恋爱|伴侣|夫妻|婚姻)关系|正式(?:交往|在一起)|死亡|去世|失踪|昏迷|重伤|住院|被捕|入狱|身份(?:暴露|揭晓|公开)|真相(?:揭开|揭晓|大白)|秘密(?:曝光|揭开|坦白)|背叛|逃婚|搬家|离家出走|立下誓言|签订婚约)/u;

function shouldRefreshMemoryEconomically(memoryValue, latestUserText = '', replyText = '') {
  const memory = support.normalizeTheaterMemory(memoryValue || {});

  // Initialize only when there is genuinely no usable checkpoint at all.
  // An intentionally empty optional section such as character_memory must not
  // turn every ordinary reply into another paid summarization call.
  if (!memory.character_anchor && !memory.plot_facts.length && !memory.current_state) return true;

  // Five completed turns means the NEXT turn reaches the six-turn checkpoint.
  if (memory.turns_since_refresh >= 5) return true;

  // Major structural changes can justify an early checkpoint, but never because
  // a memory field happens to be empty.
  if (memory.turns_since_refresh < 1) return false;
  return MAJOR_THEATER_EVENT_RE.test(`${latestUserText}\n${replyText}`);
}

support.shouldRefreshMemory = shouldRefreshMemoryEconomically;

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function theaterMemoryEconomyHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, theater_memory_economy: 'six-turn-major-events-v3-single-context' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[theater:memory:economy] express integration unavailable:', error.message);
}

module.exports = { MAJOR_THEATER_EVENT_RE, shouldRefreshMemoryEconomically };
