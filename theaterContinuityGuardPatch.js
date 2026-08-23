'use strict';

const support = require('./theaterMemorySupport');
const baseInjectMemoryIntoBody = support.injectMemoryIntoBody;
const CONTINUITY_MARKER = '【连续性硬约束·防剧情回放】';
const TIMELINE_MARKER = '【时间轴硬约束·Timeline v2】';
const CONTINUITY_GUARD = `${CONTINUITY_MARKER}\n- 【最近互动记录】与本轮玩家输入才是实时的时间线最前沿。角色记忆是周期性整理出来的检查点，可能比最近互动略旧；二者冲突时，必须以最近互动和本轮输入为准，绝不能把时间、地点、动作或关系状态倒退回旧检查点。\n- plot_facts/长期事件档案只用于承认“已经发生过以及造成的后果”，不是待执行任务。除非玩家明确要求回忆、重返或重做，否则禁止把已经完成的出发、抵达、吃饭、睡觉、送礼、争执、和好、购物、告别等情节重新演一遍。\n- “未完成线索”也只是记忆检查点中的候选事项；若最近互动已经完成、改变或越过该事项，就视为已解决或已失效，不能再次触发。\n- 每轮回复必须从玩家刚刚做出的动作/话语继续往前走；至少推进一个可观察状态，不要用旧桥段原地打转。`;
const TIMELINE_GUARD = `${TIMELINE_MARKER}\n- 【过去 → 现在 → 未来】严格按剧情已经走过的顺序理解记忆。长期事件档案描述过去，当前状态描述最近一次检查点，最近互动描述真正的现在；它们不能互换。\n- 【当前时间只认最近证据】“昨晚、今天早上、刚才、后来、第二天、明天、过了一会儿”等相对时间词，必须结合最近互动中的明确事件理解，不能因为旧记忆里出现过同一个时间词，就把剧情钟表倒退或冻结。\n- 【跨时间推进】如果近期互动已经进入下一天、下一场景或下一地点，旧的“明天要做”“今晚准备做”只能作为过去的计划看待；对应事件已经发生后，必须引用结果，不能重新执行。\n- 【未来线索不等于当前动作】open_threads 里的约定、计划、待办只能在当前剧情自然到达那个时间点时触发；已经越过时间点时，不重新执行。\n- 【当前状态覆盖旧检查点】若最近互动改变了时间、地点、人物状态、物品、关系状态或事件完成度，以最近互动为准，并继续向前写。\n- 【避免伪造跳时】除非玩家明确写出时间跳跃、倒叙、回忆或场景切换，否则不要擅自把剧情从当前时刻跳回过去。\n- 【事件完成性】最近互动已经出现“到达、离开、完成、吃完、睡醒、送出、收到、答应、拒绝、结束”等明确完成信号时，对应旧线索视为完成状态；后续可以引用结果，不能再次把它当成待完成事项。`;

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
      ? `${text.slice(0, point)}\n\n${CONTINUITY_GUARD}\n\n${TIMELINE_GUARD}${text.slice(point)}`
      : `${text.trimEnd()}\n\n${CONTINUITY_GUARD}\n\n${TIMELINE_GUARD}`;
    return { ...message, content: text };
  });
  return { ...injected, messages };
}

try {
  const express = require('express');
  const originalJson = express.response.json;
  express.response.json = function theaterContinuityHealthJson(body) {
    if (body?.message === '在云端漫步' && body?.status === 'ok') {
      body = { ...body, theater_continuity: 'live-frontier-timeline-v2' };
    }
    return originalJson.call(this, body);
  };
} catch (error) {
  console.warn('[theater:continuity] express integration unavailable:', error.message);
}

module.exports = {
  CONTINUITY_MARKER,
  TIMELINE_MARKER,
  CONTINUITY_GUARD,
  TIMELINE_GUARD,
  relabelCheckpointMemory,
  injectContinuityGuard,
};
