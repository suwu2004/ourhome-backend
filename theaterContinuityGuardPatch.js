'use strict';

const support = require('./theaterMemorySupport');

const baseInjectMemoryIntoBody = support.injectMemoryIntoBody;
const CONTINUITY_MARKER = '【连续性硬约束·防剧情回放】';
const CONTINUITY_GUARD = `${CONTINUITY_MARKER}\n- 【最近互动记录】与本轮玩家输入才是实时的时间线最前沿。角色记忆是周期性整理出来的检查点，可能比最近互动略旧；二者冲突时，必须以最近互动和本轮输入为准，绝不能把时间、地点、动作或关系状态倒退回旧检查点。\n- plot_facts/长期事件档案只用于承认“已经发生过以及造成的后果”，不是待执行任务。除非玩家明确要求回忆、重返或重做，否则禁止把已经完成的出发、抵达、吃饭、睡觉、送礼、争执、和好、购物、告别等情节重新演一遍。\n- “未完成线索”也只是记忆检查点中的候选事项；若最近互动已经完成、改变或越过该事项，就视为已解决或已失效，不能再次触发。\n- 人物习惯、口头禅、身体反应和常用动作是角色特征，不是每轮固定模板。最近几轮已经高频出现的同类动作、道具、比喻或场景描写应主动降频，除非当前情境确实需要。\n- 每轮回复必须从玩家刚刚做出的动作/话语继续往前走；自然回应即可，但至少推进一个可观察状态（行动、信息、决定、时间、地点、人物反应或既有事件的后果），不要用旧桥段原地打转。`;

function relabelCheckpointMemory(text) {
  return String(text || '')
    .replace(/【当前场景状态·时间线最前沿】/gu, '【最近一次记忆检查点·可能略旧】')
    .replace(/【未完成线索】/gu, '【记忆检查点中的未完成线索·以近期记录校验】');
}

function injectContinuityGuard(body, memory) {
  const injected = baseInjectMemoryIntoBody(body, memory);
  if (!Array.isArray(injected?.messages)) return injected;

  const messages = injected.messages.map((message, index) => {
    if (index !== 0 || typeof message?.content !== 'string') return message;
    let text = relabelCheckpointMemory(message.content);
    if (text.includes(CONTINUITY_MARKER)) return { ...message, content: text };

    const earlierPoint = text.indexOf('\n【较早剧情提要】');
    const recentPoint = text.indexOf('\n【最近互动记录】');
    const point = earlierPoint >= 0 ? earlierPoint : recentPoint;
    text = point >= 0
      ? `${text.slice(0, point)}\n\n${CONTINUITY_GUARD}${text.slice(point)}`
      : `${text.trimEnd()}\n\n${CONTINUITY_GUARD}`;
    return { ...message, content: text };
  });

  return { ...injected, messages };
}

support.injectMemoryIntoBody = injectContinuityGuard;

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function theaterContinuityHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = {
        ...body,
        theater_continuity: 'live-frontier-no-replay-v1',
      };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[theater:continuity] express integration unavailable:', error.message);
}

module.exports = {
  CONTINUITY_MARKER,
  CONTINUITY_GUARD,
  relabelCheckpointMemory,
  injectContinuityGuard,
};
