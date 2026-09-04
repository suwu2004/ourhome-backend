'use strict';

// Theater rules and lorebooks are creative aids, not a second system prompt.
// Keep hard safety/identity/continuity constraints intact, but let the model
// decide whether a soft rule or worldbook entry fits the current scene.
const previousFetch = globalThis.fetch;
const MARKER = '【小剧场设定自主权·Soft Rules & Lorebooks】';
const THEATER_RE = /OurHome 的[“"]小剧场[”"](?:长文|互动)写作引擎/u;

const AUTONOMY = `${MARKER}\n- 小剧场通用规则与世界书是本轮可参考的创作资料，不是每一条都必须机械执行的硬指令。\n- 你应根据当前真实剧情、玩家刚刚的输入、角色自洽和场景需要，自主判断哪些条目现在适用；相关的就自然采用，不相关的可以暂时忽略。\n- 如果软规则或世界书与已经发生的剧情冲突，以最近真实剧情和本轮明确输入为准，不得为了服从设定而改写已经发生的事情。\n- 世界书提供的是背景、人物、地点、关系或可能性，不等于“此刻一定发生”；不要因为某个条目被唤醒就强行让它出现在剧情里。\n- 通用规则中的创作偏好可以灵活处理；但安全边界、用户明确要求、当前角色核心设定以及时间连续性仍然属于硬约束，不可自行取消。\n- 不要向玩家解释你正在进行规则选择，也不要输出规则命中、权重或内部判断；直接把合适的内容融入自然剧情。`;

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('\n');
}

function isTheaterBody(body) {
  const system = textOf(body?.system);
  return Array.isArray(body?.messages)
    && body.messages.length > 0
    && THEATER_RE.test(system);
}

function patchSystem(system) {
  const text = textOf(system);
  if (!text || text.includes(MARKER)) return system;
  if (typeof system === 'string') return `${system.trimEnd()}\n\n${AUTONOMY}`;
  if (Array.isArray(system)) return [...system, { type: 'text', text: AUTONOMY }];
  return system;
}

function patchBody(body) {
  if (!isTheaterBody(body)) return body;
  return { ...body, system: patchSystem(body.system) };
}

if (typeof previousFetch === 'function') {
  globalThis.fetch = async function theaterPromptAutonomyFetch(input, init = {}) {
    if (typeof init.body !== 'string') return previousFetch(input, init);
    try {
      const body = JSON.parse(init.body);
      const patched = patchBody(body);
      return previousFetch(input, patched === body ? init : { ...init, body: JSON.stringify(patched) });
    } catch (error) {
      console.warn('[theater:prompt-autonomy] skipped:', error.message);
      return previousFetch(input, init);
    }
  };
}

module.exports = { MARKER, AUTONOMY, isTheaterBody, patchSystem, patchBody };
