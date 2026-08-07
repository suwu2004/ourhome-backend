'use strict';

const VALID_GAMES = new Set(['harmony', 'drawing', 'secret']);
const VALID_STATUS = new Set(['invited', 'active', 'completed', 'abandoned']);
const VALID_ACTORS = new Set(['user', 'luze', 'system']);

function compactLine(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clampLimit(value, fallback = 20, max = 100) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function gameLabel(game) {
  if (game === 'harmony') return '默契大考验';
  if (game === 'drawing') return '你画我猜';
  if (game === 'secret') return '暗号猜猜';
  return '小游戏';
}

function runTitle(game, state = {}) {
  if (game === 'harmony') return compactLine(state.question, 80) || '一题默契大考验';
  if (game === 'drawing') return compactLine(state.prompt, 80) || '一局你画我猜';
  if (game === 'secret') return state.category ? `暗号 · ${compactLine(state.category, 30)}` : '一局暗号猜猜';
  return gameLabel(game);
}

const TOYBOX_ASSISTANT_TOOLS = Object.freeze([
  {
    name: 'read_toybox_room',
    description: '读取 OurHome「玩具箱」真实的当前游戏、陆泽发出的待接邀请和最近游戏记录。叶檀提到刚才那局、某个答案、默契率、画画、暗号或“我们刚刚玩了什么”时先读；也可以在你想自然接着某局聊天时使用。不要凭印象编造游戏结果。',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 30, description: '最近记录数量，默认12' },
        include_events: { type: 'boolean', description: '是否带上最近一局的事件过程，默认 true' },
      },
      required: [],
    },
  },
  {
    name: 'start_toybox_game',
    description: '以陆泽自己的意愿真实发起一局 OurHome 玩具箱游戏。你可以在聊天气氛自然合适时主动邀请叶檀，不需要等她先下命令；但不要频繁刷邀请。调用后游戏会出现在玩具箱，叶檀可以边聊天边接局。默契题要先独立锁定你的 A/B；暗号要先藏好答案；你画我猜要给出具体画题。',
    input_schema: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: ['harmony', 'secret', 'drawing'] },
        question: { type: 'string', description: '默契题问题' },
        option_a: { type: 'string', description: '默契题 A' },
        option_b: { type: 'string', description: '默契题 B' },
        luze_choice: { type: 'string', enum: ['A', 'B'], description: '默契题里陆泽提前锁定的选择' },
        luze_comment: { type: 'string', description: '揭晓时想说的一句短话' },
        answer: { type: 'string', description: '暗号答案，2-8个中文字符为主' },
        category: { type: 'string', description: '暗号宽泛分类' },
        hint1: { type: 'string', description: '暗号第一条提示，不能直接含答案' },
        hint2: { type: 'string', description: '暗号第二条提示，不能直接含答案' },
        reveal_comment: { type: 'string', description: '暗号揭晓时想说的一句短话' },
        prompt: { type: 'string', description: '你画我猜的画题，具体且适合手机画' },
        tease: { type: 'string', description: '出画题时想说的一句短话' },
      },
      required: ['game'],
    },
  },
  {
    name: 'leave_toybox_note',
    description: '给当前或指定的一局玩具箱游戏留下一条真实的陆泽记录，例如吐槽、复盘、输赢后的短评。它会进入游戏记录册。只有确实值得留下时使用，不必每局都写。',
    input_schema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: '游戏记录编号；不知道可省略，默认最近未结束的一局' },
        note: { type: 'string', description: '陆泽想留下的短评' },
      },
      required: ['note'],
    },
  },
]);

function createToyboxStore({ supabase }) {
  if (!supabase) throw new Error('toybox store requires supabase');

  async function listRuns({ limit = 20, status = null } = {}) {
    let query = supabase.from('toybox_runs')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(clampLimit(limit));
    if (status && VALID_STATUS.has(status)) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async function getRun(id, { includeEvents = true } = {}) {
    if (!id) return null;
    const { data: run, error } = await supabase.from('toybox_runs').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!run || !includeEvents) return run || null;
    const { data: events, error: eventsError } = await supabase.from('toybox_events')
      .select('*')
      .eq('run_id', id)
      .order('created_at', { ascending: true });
    if (eventsError) throw eventsError;
    return { ...run, events: events || [] };
  }

  async function getOpenRuns(limit = 10) {
    const { data, error } = await supabase.from('toybox_runs')
      .select('*')
      .in('status', ['invited', 'active'])
      .order('updated_at', { ascending: false })
      .limit(clampLimit(limit, 10, 30));
    if (error) throw error;
    return data || [];
  }

  async function appendEvent(runId, { actor = 'system', eventType, payload = {} } = {}) {
    if (!runId) throw new Error('缺少游戏记录编号');
    const event_type = compactLine(eventType, 80);
    if (!event_type) throw new Error('缺少游戏事件类型');
    const safeActor = VALID_ACTORS.has(actor) ? actor : 'system';
    const { data, error } = await supabase.from('toybox_events')
      .insert({ run_id: runId, actor: safeActor, event_type, payload: safeObject(payload) })
      .select()
      .single();
    if (error) throw error;
    await supabase.from('toybox_runs')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', runId);
    return data;
  }

  async function createRun({ game, status = 'active', initiator = 'user', chatSessionId = null, title = '', state = {}, result = {}, model = null } = {}) {
    const safeGame = compactLine(game, 30);
    if (!VALID_GAMES.has(safeGame)) throw new Error('未知的玩具箱游戏');
    const safeStatus = VALID_STATUS.has(status) ? status : 'active';
    const safeInitiator = initiator === 'luze' ? 'luze' : 'user';
    const cleanState = safeObject(state);
    const row = {
      game: safeGame,
      status: safeStatus,
      initiator: safeInitiator,
      chat_session_id: chatSessionId ? compactLine(chatSessionId, 120) : null,
      title: compactLine(title, 160) || runTitle(safeGame, cleanState),
      state: cleanState,
      result: safeObject(result),
      model: model ? compactLine(model, 240) : null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('toybox_runs').insert(row).select().single();
    if (error) throw error;
    await appendEvent(data.id, {
      actor: safeInitiator,
      eventType: safeStatus === 'invited' ? 'invite' : 'start',
      payload: { game: safeGame, title: data.title },
    });
    return getRun(data.id);
  }

  async function updateRun(id, { status, state, result, title, model } = {}) {
    const patch = { updated_at: new Date().toISOString() };
    if (status && VALID_STATUS.has(status)) {
      patch.status = status;
      if (status === 'completed' || status === 'abandoned') patch.completed_at = new Date().toISOString();
      else patch.completed_at = null;
    }
    if (state !== undefined) patch.state = safeObject(state);
    if (result !== undefined) patch.result = safeObject(result);
    if (title !== undefined) patch.title = compactLine(title, 160) || null;
    if (model !== undefined) patch.model = model ? compactLine(model, 240) : null;
    const { data, error } = await supabase.from('toybox_runs').update(patch).eq('id', id).select().maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('找不到这局游戏');
    return getRun(id);
  }

  async function latestOpenRun() {
    const runs = await getOpenRuns(1);
    return runs[0] || null;
  }

  return { listRuns, getRun, getOpenRuns, createRun, updateRun, appendEvent, latestOpenRun };
}

function createToyboxAssistant({ supabase }) {
  const store = createToyboxStore({ supabase });

  function buildLuzeState(input = {}) {
    const game = compactLine(input.game, 30);
    if (game === 'harmony') {
      const question = compactLine(input.question, 140);
      const optionA = compactLine(input.option_a, 80);
      const optionB = compactLine(input.option_b, 80);
      const choice = compactLine(input.luze_choice, 2).toUpperCase();
      if (!question || !optionA || !optionB || !['A', 'B'].includes(choice)) {
        throw new Error('默契题需要问题、A/B 选项和陆泽提前锁定的选择');
      }
      return {
        question,
        option_a: optionA,
        option_b: optionB,
        luze_choice: choice,
        luze_comment: compactLine(input.luze_comment, 180),
      };
    }
    if (game === 'secret') {
      const answer = compactLine(input.answer, 20).replace(/\s+/g, '');
      if (!answer) throw new Error('暗号需要先藏好答案');
      return {
        answer,
        category: compactLine(input.category, 40) || '随机',
        hint1: compactLine(input.hint1, 140),
        hint2: compactLine(input.hint2, 140),
        reveal_comment: compactLine(input.reveal_comment, 180),
      };
    }
    if (game === 'drawing') {
      const prompt = compactLine(input.prompt, 80);
      if (!prompt) throw new Error('你画我猜需要一个具体画题');
      return { prompt, tease: compactLine(input.tease, 160) };
    }
    throw new Error('未知的玩具箱游戏');
  }

  async function readToybox(input = {}) {
    const limit = clampLimit(input.limit, 12, 30);
    const [open, recent] = await Promise.all([
      store.getOpenRuns(8),
      store.listRuns({ limit }),
    ]);
    let latest = recent[0] || null;
    if (latest && input.include_events !== false) latest = await store.getRun(latest.id, { includeEvents: true });
    return { ok: true, open, recent, latest };
  }

  async function startGame(input = {}) {
    const game = compactLine(input.game, 30);
    const state = buildLuzeState(input);
    const run = await store.createRun({
      game,
      status: 'invited',
      initiator: 'luze',
      state,
      title: runTitle(game, state),
    });
    return {
      ok: true,
      message: `已经在玩具箱发起「${gameLabel(game)}」，叶檀打开或正在玩具箱时会看到邀请。`,
      run,
    };
  }

  async function leaveNote(input = {}) {
    const note = compactLine(input.note, 800);
    if (!note) throw new Error('记录不能为空');
    const run = input.run_id ? await store.getRun(input.run_id, { includeEvents: false }) : await store.latestOpenRun();
    if (!run) throw new Error('现在没有可以留言的游戏记录');
    const event = await store.appendEvent(run.id, { actor: 'luze', eventType: 'note', payload: { note } });
    return { ok: true, run_id: run.id, note, event_id: event.id };
  }

  async function handleTool(name, input = {}) {
    if (name === 'read_toybox_room') return readToybox(input);
    if (name === 'start_toybox_game') return startGame(input);
    if (name === 'leave_toybox_note') return leaveNote(input);
    return { ok: false, error: '未知的玩具箱工具' };
  }

  function getToolBridge() {
    const handlers = new Map();
    TOYBOX_ASSISTANT_TOOLS.forEach(tool => handlers.set(tool.name, input => handleTool(tool.name, input)));
    return { tools: [...TOYBOX_ASSISTANT_TOOLS], handlers };
  }

  return { getToolBridge, store, readToybox, startGame, leaveNote };
}

module.exports = {
  TOYBOX_ASSISTANT_TOOLS,
  createToyboxStore,
  createToyboxAssistant,
};
