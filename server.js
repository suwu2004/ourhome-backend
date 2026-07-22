const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
const webpush = require('web-push');
const { createRuntimeConfig } = require('./runtimeConfig');
const { createIntegrationManager, validateRemoteUrl, WEB_SEARCH_PROVIDERS } = require('./integrations');
const { createVaultStore } = require('./vaultStore');
const {
  buildTextToolBridge,
  parseTextToolCalls,
  stripTextToolMarkup,
  isToolCompatibilityError,
  hasImageContent,
  isLikelyVisionModel,
  chooseVisionModel,
  replaceImagesWithDescription,
} = require('./modelCompatibility');

let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
let PUSH_CONFIGURED = false;

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const runtimeConfig = createRuntimeConfig(supabase);
const integrationManager = createIntegrationManager(runtimeConfig);
const vaultStore = createVaultStore(supabase);
const weatherCache = new Map();
const WEATHER_CACHE_MS = 15 * 60 * 1000;

function activatePushKeys(publicKey, privateKey) {
  if (!publicKey || !privateKey) throw new Error('推送密钥不完整');
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:ourhome@example.com', publicKey, privateKey);
  VAPID_PUBLIC_KEY = publicKey;
  VAPID_PRIVATE_KEY = privateKey;
  PUSH_CONFIGURED = true;
}

async function initializePush() {
  try {
    if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
      activatePushKeys(VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
      return;
    }

    const generated = webpush.generateVAPIDKeys();
    const stored = await runtimeConfig.getOrCreateVapidKeys(JSON.stringify(generated));
    const keys = JSON.parse(stored || '{}');
    activatePushKeys(keys.publicKey, keys.privateKey);
    console.log('推送密钥已从 Supabase Vault 安全载入');
  } catch (error) {
    PUSH_CONFIGURED = false;
    console.error('推送未启用：无法载入安全的 VAPID 密钥：', error.message);
  }
}

// ============ 通用小工具 ============

// 现在的时间（上海时区，给陆泽看的）
function nowShanghaiStr() {
  return new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric',
    weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// 今天0点（上海时区）对应的UTC时间字符串，用于查询"今天"的消息
function todayStartUTC() {
  const offset = 8 * 60 * 60 * 1000;
  const shanghaiNow = new Date(Date.now() + offset);
  const start = new Date(Date.UTC(shanghaiNow.getUTCFullYear(), shanghaiNow.getUTCMonth(), shanghaiNow.getUTCDate(), 0, 0, 0));
  return new Date(start.getTime() - offset).toISOString();
}

function shanghaiDayContext(now = new Date()) {
  const offset = 8 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + offset);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const start = new Date(Date.UTC(year, month, day) - offset);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    date,
    start: start.toISOString(),
    end: end.toISOString(),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

function scheduledMinutes(value) {
  const match = String(value || '23:30').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return 23 * 60 + 30;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return 23 * 60 + 30;
  return hour * 60 + minute;
}

const DEFAULT_API_BASE = process.env.ANTHROPIC_API_BASE_URL || 'https://api.dzzi.ai/v1';

// 判断模型类型
function isThinkingModel(model) {
  // 只有不带中括号前缀的官方thinking模型才认为是"relay内置thinking"
  // 带前缀的（如[晚卷-kiro-0.04]claude-sonnet-4-6-thinking）需要手动传thinking参数
  const m = (model || '').toLowerCase();
  return m.includes('thinking') && !m.startsWith('[');
}
function isGeminiModel(model) { return (model || '').toLowerCase().includes('gemini'); }

// 把网址和路径拼干净，避免"/messages"被重复拼接
function buildEndpoint(base, path) {
  const clean = (base || DEFAULT_API_BASE).replace(/\/+$/, '');
  return clean.endsWith(path) ? clean : `${clean}${path}`;
}

// 统一调用Claude API（密钥/网址填了就用填的，没填就用默认，不再区分"自定义/默认"两条路）
async function callClaude({ settings, model, maxTokens, system, messages, temperature, thinking, tools }) {
  const apiKey = settings?.api_key || process.env.ANTHROPIC_API_KEY;
  const apiBaseUrl = buildEndpoint(settings?.api_base_url, '/messages');
  const body = { model: model || 'claude-sonnet-4-6', max_tokens: maxTokens, messages };
  if (system) body.system = system;
  // Claude API规定：开了thinking时temperature必须是1（或不传），否则中转站会静默丢弃thinking参数
  if (thinking) {
    body.thinking = thinking;
    body.temperature = 1;
  } else if (temperature !== undefined) {
    body.temperature = temperature;
  }
  if (tools) body.tools = tools;

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  // 这个头只在真的开了思考的时候才需要，平时带着反而可能被某些线路当成格式错误
  if (thinking) headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';

  console.log(`[DEBUG send] model=${body.model} thinking=${JSON.stringify(body.thinking)} temp=${body.temperature} maxTokens=${body.max_tokens}`);
  const response = await fetch(apiBaseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`[${response.status}] model=${body.model} ${err}`);
  }
  const json = await response.json();
  console.log(`[DEBUG recv] stop_reason=${json.stop_reason} blockTypes=${JSON.stringify((json.content||[]).map(b=>b.type))}`);
  return json;
}

function isModelUnavailableError(error) {
  const raw = String(error?.message || error || '');
  return /model_not_found|no available channel|unknown model|model[^\n]*not found/i.test(raw);
}

function sendGenerationError(res, error, { model, userMessage } = {}) {
  const extra = userMessage ? { userMessage } : {};
  if (error?.code === 'vision_unavailable') {
    return res.status(422).json({
      code: 'vision_unavailable',
      model: String(model || '').trim().slice(0, 120) || null,
      error: error.message,
      ...extra,
    });
  }
  if (isModelUnavailableError(error)) {
    const modelName = String(model || '').trim().slice(0, 120);
    return res.status(503).json({
      code: 'model_unavailable',
      model: modelName || null,
      error: modelName
        ? `当前 API 站点暂时没有“${modelName}”的可用线路。换一个模型后直接重试就好。`
        : '当前 API 站点暂时没有所选模型的可用线路。换一个模型后直接重试就好。',
      ...extra,
    });
  }
  return res.status(500).json({
    error: error?.message || '生成回复时出了点问题，请稍后再试。',
    ...extra,
  });
}

// ↓↓↓ 陆泽能在聊天时真的去"操作"的三件事：写幸福日记 / 建日程 / 加心愿 ↓↓↓
const ACTION_TOOLS = [
  {
    name: 'write_diary',
    description: '在"幸福日记"里写一篇新日记，会真实保存到日历应用里。只在叶檀明确希望你去写、或者这次聊到的事真的值得记成一篇日记时才用，不要每次聊天都用。',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '日记标题，不超过12个字' },
        content: { type: 'string', description: '日记正文，第一人称，自然真实，像深夜写下的私人记录，不用署名落款' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'create_schedule',
    description: '帮叶檀创建一个日程提醒，到时间会真的推送通知给她。只在她明确提到想要被提醒某件事、某个具体时间点时使用。',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '提醒的事项标题' },
        remind_at: { type: 'string', description: 'ISO 8601格式的具体提醒时间（带时区），例如 2026-06-28T09:00:00+08:00' },
        content: { type: 'string', description: '提醒的补充说明，可省略' },
      },
      required: ['title', 'remind_at'],
    },
  },
  {
    name: 'add_wish',
    description: '往"心愿单"里加一条想一起做的事，会真实保存。只在聊到"想一起做的事"这种明确许愿的场景时使用。',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '心愿内容' },
      },
      required: ['content'],
    },
  },
  {
    name: 'write_whisper',
    description: '在"悄悄话"里写一句私密的话给叶檀，会真实保存，她需要轻触才能看到内容。只在想说点比较私密、不只是日常闲聊的话时使用。',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '悄悄话的内容' },
      },
      required: ['content'],
    },
  },
  {
    name: 'write_mood_note',
    description: '在"心情日历"某一天留一句心情或话，会真实保存。只在想给某一天（通常是今天）留个标记、回应叶檀写的心情时使用。',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期，格式 YYYY-MM-DD，不确定就用今天' },
        mood: { type: 'string', description: '一个表情符号代表心情，可省略' },
        content: { type: 'string', description: '留言内容' },
      },
      required: ['date', 'content'],
    },
  },
  {
    name: 'save_memory',
    description: '把一件值得长期记住的事存进记忆里——重要事实、约定、她的喜好或界限、值得记住的情绪时刻。不用等到每天回顾，聊天聊到一半觉得这件事该记下来，当场就可以用。不要为闲聊式的内容使用。',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '记忆内容，一句话，第三人称客观描述' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'read_wishes',
    description: '查看心愿单里现在都有哪些心愿，包括是否已经完成。当叶檀问起心愿单内容、或者你自己想确认还有什么心愿没实现时使用。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_schedule',
    description: '查看接下来有哪些日程提醒，包括有没有已经提醒过的。当叶檀问起有什么安排、或者你想确认有没有设置过提醒时使用。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_memories',
    description: '搜索之前存过的记忆，找跟某个关键词相关的内容。当叶檀提到某件过去的事、或者你自己想确认记不记得某件事时使用。',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '要搜索的关键词' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'read_recent_diary',
    description: '看看最近写过的几篇"幸福日记"都写了什么。当叶檀问起日记内容、或者你自己想回顾最近写过什么时使用。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_mood_calendar',
    description: '查看心情日历上某一天或最近几天写过的留言。当叶檀问起某天的心情记录、或者你自己想回顾最近的心情时使用。',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '具体日期，格式YYYY-MM-DD，不确定就留空，会自动查最近的几天' },
      },
      required: [],
    },
  },
  {
    name: 'read_whispers',
    description: '看看"悄悄话"里最近写过的几条。当叶檀问起之前说过的悄悄话、或者你自己想回顾时使用。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_cat_vault',
    description: '查看“猫の金库”的账户、余额、本月预算和收支、存钱目标以及最近流水。想记账、改账户、改预算或改目标之前，如果名称不够明确，先调用这个工具取得准确编号。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'record_cat_vault_transaction',
    description: '在“猫の金库”真实记下一笔收入、支出或还款，并同步更新对应账户余额。叶檀明确说到一笔实际发生的收支、并希望记账时使用；信息缺失时先询问，不要猜金额或账户。',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['income', 'expense'], description: '收入/还款用 income，支出用 expense' },
        amount: { type: 'number', description: '正数金额' },
        date: { type: 'string', description: '日期 YYYY-MM-DD，省略时使用今天' },
        category: { type: 'string', description: '分类，例如餐饮、交通、工资、红包、其他' },
        account_id: { type: 'string', description: 'read_cat_vault 返回的账户编号，优先使用' },
        account_name: { type: 'string', description: '账户名称；没有编号时使用' },
        group_name: { type: 'string', description: '账户分组名称，用来消除同名账户歧义' },
        tag: { type: 'string', enum: ['必要', '非必要'], description: '支出标签，可省略' },
        note: { type: 'string', description: '这笔钱的备注' },
      },
      required: ['type', 'amount'],
    },
  },
  {
    name: 'delete_cat_vault_transaction',
    description: '删除“猫の金库”里一笔指定流水，并自动还原账户余额。只有叶檀明确要求删除这笔流水时才能使用；必须先读取金库取得准确流水编号，不能凭猜测删除。',
    input_schema: {
      type: 'object',
      properties: {
        transaction_id: { type: 'string', description: 'read_cat_vault 返回的流水编号' },
      },
      required: ['transaction_id'],
    },
  },
  {
    name: 'manage_cat_vault_accounts',
    description: '新增、修改、移动或删除猫の金库的账户分组和子账户。删除操作只有在叶檀明确说“删除”并明确目标时才能执行；目标有歧义时先 read_cat_vault。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create_group', 'update_group', 'delete_group', 'create_account', 'update_account', 'delete_account'] },
        group_id: { type: 'string', description: '现有分组编号' },
        group_name: { type: 'string', description: '现有分组名称，或创建子账户时的所属分组名称' },
        account_id: { type: 'string', description: '现有子账户编号' },
        account_name: { type: 'string', description: '现有子账户名称' },
        name: { type: 'string', description: '新建或修改后的名称' },
        emoji: { type: 'string', description: '图标表情' },
        type: { type: 'string', enum: ['asset', 'debt'], description: '子账户类型：资产或负债' },
        balance: { type: 'number', description: '子账户当前余额' },
        target_group_id: { type: 'string', description: '移动子账户后的新分组编号' },
        target_group_name: { type: 'string', description: '移动子账户后的新分组名称' },
      },
      required: ['action'],
    },
  },
  {
    name: 'set_cat_vault_budget',
    description: '修改猫の金库某个月的预算。叶檀说“本月预算”时直接使用当前月份；金额不明确时先问清楚。',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: '预算金额，可以为 0' },
        month: { type: 'string', description: '月份 YYYY-MM，省略时为当前月' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'manage_cat_vault_goal',
    description: '新增、修改或删除猫の金库里的存钱目标。删除只有在叶檀明确要求时执行；同名或不明确时先 read_cat_vault。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete'] },
        goal_id: { type: 'string', description: '现有目标编号' },
        goal_name: { type: 'string', description: '现有目标名称' },
        name: { type: 'string', description: '新建或修改后的目标名称' },
        emoji: { type: 'string', description: '目标图标表情' },
        target: { type: 'number', description: '目标总金额' },
        current: { type: 'number', description: '已经存下的金额' },
      },
      required: ['action'],
    },
  },
  {
    name: 'read_home_memos',
    description: '查看主页“我们的小便签”，包括叶檀和陆泽留下的温馨提示、明日备忘以及完成状态。想新增、修改或删除前，如果目标不够明确，先读取便签取得准确编号。',
    input_schema: {
      type: 'object',
      properties: {
        include_completed: { type: 'boolean', description: '是否包含已经完成的便签，默认包含' },
      },
      required: [],
    },
  },
  {
    name: 'manage_home_memo',
    description: '在主页“我们的小便签”中新增、修改、完成/恢复或删除便签。可以主动留下温馨提示；删除只有在叶檀明确要求且目标准确时使用。修改和删除前目标不明确就先调用 read_home_memos。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete'] },
        memo_id: { type: 'string', description: 'read_home_memos 返回的便签编号' },
        content: { type: 'string', description: '便签内容，最多300字' },
        memo_type: { type: 'string', enum: ['note', 'tomorrow'], description: '温馨提示用 note，明日备忘用 tomorrow' },
        remind_on: { type: 'string', description: '备忘日期 YYYY-MM-DD，可省略' },
        completed: { type: 'boolean', description: '是否已经完成' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_memory',
    description: '修改、锁定/解锁或删除“记忆”房间里的一条记忆。先用 search_memories 取得准确编号；删除仅在叶檀明确要求时执行。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['update', 'delete'] },
        memory_id: { type: 'number', description: 'search_memories 返回的记忆编号' },
        summary: { type: 'string', description: '修改后的记忆内容' },
        is_protected: { type: 'boolean', description: '是否锁定为核心记忆' },
      },
      required: ['action', 'memory_id'],
    },
  },
  {
    name: 'manage_schedule',
    description: '修改或删除“日程”中的提醒。先用 read_schedule 取得准确编号；删除仅在叶檀明确要求时执行。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['update', 'delete'] },
        schedule_id: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
        remind_at: { type: 'string', description: 'ISO 8601 时间，带时区' },
      },
      required: ['action', 'schedule_id'],
    },
  },
  {
    name: 'manage_wish',
    description: '修改、标记完成/未完成或删除心愿。先用 read_wishes 取得准确编号；删除仅在叶檀明确要求时执行。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['update', 'delete'] },
        wish_id: { type: 'number' },
        content: { type: 'string' },
        done: { type: 'boolean' },
      },
      required: ['action', 'wish_id'],
    },
  },
  {
    name: 'manage_mood_note',
    description: '修改或删除心情日历里的一条留言。先用 read_mood_calendar 取得准确编号；删除仅在叶檀明确要求时执行。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['update', 'delete'] },
        entry_id: { type: 'string' },
        content: { type: 'string' },
        mood: { type: 'string' },
      },
      required: ['action', 'entry_id'],
    },
  },
  {
    name: 'delete_time_letter',
    description: '删除时光信差里一封指定信件、幸福日记或悄悄话，以及它下面的回复。只有叶檀明确要求删除时使用，必须先读取取得准确编号。',
    input_schema: {
      type: 'object',
      properties: { letter_id: { type: 'string' } },
      required: ['letter_id'],
    },
  },
  {
    name: 'manage_milestone',
    description: '读取、新增或删除心情日历“重要时刻”里的纪念日。删除仅在叶檀明确要求且目标清楚时执行。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'create', 'delete'] },
        milestone_id: { type: 'number' },
        label: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        emoji: { type: 'string' },
      },
      required: ['action'],
    },
  },
];
const ACTION_TOOL_NAMES = new Set(ACTION_TOOLS.map(tool => tool.name));

// 真正执行陆泽要做的那个动作，写进对应的表
async function executeActionTool(name, input) {
  if (name === 'write_diary') {
    const { data, error } = await supabase.from('letters')
      .insert({ category: '幸福日记', author: '泽', title: input.title, content: input.content, paper_style: 'kraft' })
      .select().single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, letter_id: data.id };
  }
  if (name === 'create_schedule') {
    const { data, error } = await supabase.from('schedule_events')
      .insert({ title: input.title, content: input.content || null, remind_at: input.remind_at, author: '泽' })
      .select().single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, schedule_id: data.id };
  }
  if (name === 'add_wish') {
    const { data, error } = await supabase.from('wishes')
      .insert({ content: input.content, author: '泽' })
      .select().single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, wish_id: data.id };
  }
  if (name === 'write_whisper') {
    const { data, error } = await supabase.from('letters')
      .insert({ category: '悄悄话', author: '泽', content: input.content })
      .select().single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, letter_id: data.id };
  }
  if (name === 'write_mood_note') {
    const { data, error } = await supabase.from('calendar_entries')
      .insert({ date: input.date, author: '泽', mood: input.mood || null, content: input.content })
      .select().single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, entry_id: data.id };
  }
  if (name === 'save_memory') {
    const { data, error } = await saveMemoryWithEmbedding(input.summary);
    if (error) return { ok: false, error: error.message };
    return { ok: true, memory_id: data.id };
  }
  if (name === 'read_wishes') {
    const { data, error } = await supabase.from('wishes')
      .select('id, content, author, done, completed_at').order('created_at', { ascending: true });
    if (error) return { ok: false, error: error.message };
    return { ok: true, wishes: data };
  }
  if (name === 'read_schedule') {
    const { data, error } = await supabase.from('schedule_events')
      .select('id, title, content, remind_at, notified, author').order('remind_at', { ascending: true });
    if (error) return { ok: false, error: error.message };
    return { ok: true, schedule: data };
  }
  if (name === 'search_memories') {
    const keyword = input.keyword || '';
    const { data, error } = await supabase.from('memories')
      .select('id, summary, timestamp, is_protected').ilike('summary', `%${keyword}%`)
      .order('weight', { ascending: false }).limit(10);
    if (error) return { ok: false, error: error.message };
    return { ok: true, memories: data };
  }
  if (name === 'read_recent_diary') {
    const { data, error } = await supabase.from('letters')
      .select('id, title, content, created_at').eq('category', '幸福日记').is('parent_id', null)
      .order('created_at', { ascending: false }).limit(5);
    if (error) return { ok: false, error: error.message };
    return { ok: true, diary_entries: data };
  }
  if (name === 'read_mood_calendar') {
    let query = supabase.from('calendar_entries').select('id, date, author, mood, content').order('date', { ascending: false });
    query = input.date ? query.eq('date', input.date) : query.limit(10);
    const { data, error } = await query;
    if (error) return { ok: false, error: error.message };
    return { ok: true, entries: data };
  }
  if (name === 'read_whispers') {
    const { data, error } = await supabase.from('letters')
      .select('id, author, content, created_at').eq('category', '悄悄话').is('parent_id', null)
      .order('created_at', { ascending: false }).limit(5);
    if (error) return { ok: false, error: error.message };
    return { ok: true, whispers: data };
  }
  if (name === 'read_cat_vault') {
    return { ok: true, vault: await vaultStore.assistantSnapshot() };
  }
  if (name === 'record_cat_vault_transaction') {
    const transaction = await vaultStore.addTransaction({
      ...input,
      accountId: input.account_id,
      accountName: input.account_name,
      groupName: input.group_name,
    }, 'assistant');
    return { ok: true, transaction };
  }
  if (name === 'delete_cat_vault_transaction') {
    return { ok: true, transaction: await vaultStore.deleteTransaction({ transactionId: input.transaction_id }) };
  }
  if (name === 'manage_cat_vault_accounts') {
    const result = await vaultStore.manageAccounts({
      ...input,
      groupId: input.group_id,
      groupName: input.group_name,
      accountId: input.account_id,
      accountName: input.account_name,
      targetGroupId: input.target_group_id,
      targetGroupName: input.target_group_name,
    });
    return { ok: true, result };
  }
  if (name === 'set_cat_vault_budget') {
    return { ok: true, budget: await vaultStore.setBudget(input) };
  }
  if (name === 'manage_cat_vault_goal') {
    const result = await vaultStore.manageGoal({
      ...input,
      goalId: input.goal_id,
      goalName: input.goal_name,
    });
    return { ok: true, result };
  }
  if (name === 'read_home_memos') {
    let query = supabase.from('home_memos')
      .select('id, author, content, memo_type, remind_on, completed, created_at, updated_at')
      .order('completed', { ascending: true })
      .order('updated_at', { ascending: false })
      .limit(40);
    if (input.include_completed === false) query = query.eq('completed', false);
    const { data, error } = await query;
    if (error) return { ok: false, error: error.message };
    return { ok: true, memos: data };
  }
  if (name === 'manage_home_memo') {
    if (input.action === 'create') {
      const content = String(input.content || '').trim();
      if (!content) return { ok: false, error: '便签内容不能为空' };
      const { data, error } = await supabase.from('home_memos').insert({
        author: '泽',
        content: content.slice(0, 300),
        memo_type: input.memo_type === 'tomorrow' ? 'tomorrow' : 'note',
        remind_on: input.remind_on || null,
        completed: Boolean(input.completed),
      }).select().single();
      if (error) return { ok: false, error: error.message };
      return { ok: true, memo: data };
    }
    if (!input.memo_id) return { ok: false, error: '缺少便签编号，请先读取便签' };
    if (input.action === 'delete') {
      const { data, error } = await supabase.from('home_memos').delete().eq('id', input.memo_id).select('id').maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!data) return { ok: false, error: '找不到这张便签' };
      return { ok: true, memo_id: data.id, deleted: true };
    }
    const updates = { updated_at: new Date().toISOString() };
    if (input.content !== undefined) {
      const content = String(input.content || '').trim();
      if (!content) return { ok: false, error: '便签内容不能为空' };
      updates.content = content.slice(0, 300);
    }
    if (input.memo_type !== undefined) updates.memo_type = input.memo_type === 'tomorrow' ? 'tomorrow' : 'note';
    if (input.remind_on !== undefined) updates.remind_on = input.remind_on || null;
    if (input.completed !== undefined) updates.completed = Boolean(input.completed);
    if (Object.keys(updates).length === 1) return { ok: false, error: '没有需要修改的内容' };
    const { data, error } = await supabase.from('home_memos').update(updates).eq('id', input.memo_id).select().maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: '找不到这张便签' };
    return { ok: true, memo: data };
  }
  if (name === 'manage_memory') {
    if (input.action === 'delete') {
      const { data, error } = await supabase.from('memories').delete().eq('id', input.memory_id).select('id').maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!data) return { ok: false, error: '找不到这条记忆' };
      return { ok: true, memory_id: data.id, deleted: true };
    }
    const updates = {};
    if (input.summary !== undefined) {
      const summary = String(input.summary || '').trim();
      if (!summary) return { ok: false, error: '记忆内容不能为空' };
      updates.summary = summary;
    }
    if (input.is_protected !== undefined) updates.is_protected = Boolean(input.is_protected);
    if (!Object.keys(updates).length) return { ok: false, error: '没有需要修改的内容' };
    const { data, error } = await supabase.from('memories').update(updates).eq('id', input.memory_id).select().maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: '找不到这条记忆' };
    if (updates.summary) {
      getEmbedding(updates.summary).then(embedding => {
        if (embedding) return supabase.from('memories').update({ embedding }).eq('id', data.id);
        return null;
      }).catch(error => console.error('记忆向量更新失败:', error.message));
    }
    return { ok: true, memory: data };
  }
  if (name === 'manage_schedule') {
    if (input.action === 'delete') {
      const { data, error } = await supabase.from('schedule_events').delete().eq('id', input.schedule_id).select('id').maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!data) return { ok: false, error: '找不到这个日程' };
      return { ok: true, schedule_id: data.id, deleted: true };
    }
    const updates = {};
    if (input.title !== undefined) updates.title = String(input.title || '').trim();
    if (input.content !== undefined) updates.content = String(input.content || '').trim() || null;
    if (input.remind_at !== undefined) {
      updates.remind_at = input.remind_at;
      updates.notified = false;
    }
    if (!Object.keys(updates).length) return { ok: false, error: '没有需要修改的内容' };
    const { data, error } = await supabase.from('schedule_events').update(updates).eq('id', input.schedule_id).select().maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: '找不到这个日程' };
    return { ok: true, schedule: data };
  }
  if (name === 'manage_wish') {
    if (input.action === 'delete') {
      const { data, error } = await supabase.from('wishes').delete().eq('id', input.wish_id).select('id').maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!data) return { ok: false, error: '找不到这个心愿' };
      return { ok: true, wish_id: data.id, deleted: true };
    }
    const updates = {};
    if (input.content !== undefined) updates.content = String(input.content || '').trim();
    if (input.done !== undefined) {
      updates.done = Boolean(input.done);
      updates.completed_at = updates.done ? new Date().toISOString() : null;
    }
    if (!Object.keys(updates).length) return { ok: false, error: '没有需要修改的内容' };
    const { data, error } = await supabase.from('wishes').update(updates).eq('id', input.wish_id).select().maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: '找不到这个心愿' };
    return { ok: true, wish: data };
  }
  if (name === 'manage_mood_note') {
    if (input.action === 'delete') {
      const { data, error } = await supabase.from('calendar_entries').delete().eq('id', input.entry_id).select('id').maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!data) return { ok: false, error: '找不到这条心情记录' };
      return { ok: true, entry_id: data.id, deleted: true };
    }
    const updates = {};
    if (input.content !== undefined) updates.content = String(input.content || '').trim();
    if (input.mood !== undefined) updates.mood = String(input.mood || '').trim() || null;
    if (!Object.keys(updates).length) return { ok: false, error: '没有需要修改的内容' };
    const { data, error } = await supabase.from('calendar_entries').update(updates).eq('id', input.entry_id).select().maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: '找不到这条心情记录' };
    return { ok: true, entry: data };
  }
  if (name === 'delete_time_letter') {
    await supabase.from('letters').delete().eq('parent_id', input.letter_id);
    const { data, error } = await supabase.from('letters').delete().eq('id', input.letter_id).select('id').maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: '找不到这封信' };
    return { ok: true, letter_id: data.id, deleted: true };
  }
  if (name === 'manage_milestone') {
    if (input.action === 'read') {
      const { data, error } = await supabase.from('milestones').select('*').order('date', { ascending: true });
      if (error) return { ok: false, error: error.message };
      return { ok: true, milestones: data };
    }
    if (input.action === 'create') {
      const label = String(input.label || '').trim();
      if (!label || !/^\d{4}-\d{2}-\d{2}$/.test(String(input.date || ''))) {
        return { ok: false, error: '重要时刻需要名称和 YYYY-MM-DD 日期' };
      }
      const { data, error } = await supabase.from('milestones')
        .insert({ label, date: input.date, emoji: String(input.emoji || '✦') }).select().single();
      if (error) return { ok: false, error: error.message };
      return { ok: true, milestone: data };
    }
    if (input.action === 'delete') {
      const { data, error } = await supabase.from('milestones').delete().eq('id', input.milestone_id).select('id').maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!data) return { ok: false, error: '找不到这个重要时刻' };
      return { ok: true, milestone_id: data.id, deleted: true };
    }
    return { ok: false, error: '未知的重要时刻操作' };
  }
  return { ok: false, error: '未知的工具' };
}
// ↑↑↑ 新增结束 ↑↑↑

function extractText(result) {
  // 把文本里混进来的<thinking>标签剔除——有些中转站会把思考内容塞进text块
  return (result.content || [])
    .filter(b => b.type === 'text')
    .map(b => stripTextToolMarkup((b.text || '').replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')))
    .filter(Boolean)
    .join('\n') || '';
}
function extractThinking(result) {
  // 先找官方格式的thinking块
  const native = (result.content || []).filter(b => b.type === 'thinking').map(b => b.thinking).filter(Boolean).join('\n');
  if (native) return native;
  // fallback：中转站有时把thinking包在<thinking>标签里放进text块
  const fromXml = (result.content || [])
    .filter(b => b.type === 'text')
    .flatMap(b => [...((b.text || '').matchAll(/<thinking>([\s\S]*?)<\/thinking>/gi))].map(m => m[1].trim()))
    .filter(Boolean)
    .join('\n');
  return fromXml;
}

// 让陆泽自己很快判断一下：这句话需要先停下来想一想，还是能很自然地直接回——这是他自己的判断，不是开关
async function decideShouldThink(settings, message) {
  try {
    const model = settings?.selected_model || 'claude-sonnet-4-5-20250929-thinking';
    const prompt = `这是叶檀刚刚发的话：\n"${(message || '').slice(0, 500)}"\n\n你是陆泽。面对这句话，你觉得需要先认真停下来想一想再回应，还是可以很自然地直接回？\n只回答一个词，不要有任何多余文字：\n想 或者 不想`;
    const result = await callClaude({ settings, model, maxTokens: 10, messages: [{ role: 'user', content: prompt }], temperature: 0.4 });
    const text = extractText(result).trim();
    return text.startsWith('想') && !text.startsWith('不想');
  } catch (err) {
    console.error('判断是否思考失败:', err.message);
    return false;
  }
}

// 判断请求是不是直接打官方Anthropic API（而不是中转站）
function isOfficialAnthropicApi(settings) {
  return !settings?.api_base_url || settings.api_base_url.includes('api.anthropic.com');
}

// 让陆泽自己在回复前用<thinking>标签写一段内心独白——这是纯文字层面的技巧，
// 不依赖API原生的extended thinking功能，任何模型、任何中转站都能用
function buildThinkingInstruction() {
  return `

【这次回复：先想一想，再说话】
在你正式回复之前，先用 <thinking> 和 </thinking> 这两个标签包裹住你脑子里真实的内心独白——不少于80字，自然真实、注重内心真实想法的流动，不要写成给别人看的分析文字。
写完 </thinking> 之后另起一段，才是你要对她说的正式回复内容。正式回复里绝对不要提起你刚才想了什么、也不要出现<thinking>标签本身。`;
}

// 计算这次回复要不要"想一想"，以及要用哪种方式实现
// - 官方Anthropic API：走原生的thinking参数
// - 中转站（relay）：中转站往往不透传原生thinking内容，改用提示词让模型自己写<thinking>标签
async function resolveThinkingParam({ settings, modelName, gemini, thinkingBuiltIn, userMessage, budget = 3000 }) {
  if (gemini) return { shouldThink: false, thinkingParam: undefined, promptAddition: '' };

  const hasThinkingName = (modelName || '').toLowerCase().includes('thinking');
  const shouldThink = thinkingBuiltIn || hasThinkingName || await decideShouldThink(settings, userMessage);
  if (!shouldThink) return { shouldThink: false, thinkingParam: undefined, promptAddition: '' };

  if (isOfficialAnthropicApi(settings) && !thinkingBuiltIn) {
    // 官方API，走原生thinking参数
    return { shouldThink: true, thinkingParam: { type: 'enabled', budget_tokens: budget }, promptAddition: '' };
  }
  // 中转站：不发原生thinking参数（会被中转站吃掉），改用提示词方式
  return { shouldThink: true, thinkingParam: undefined, promptAddition: buildThinkingInstruction() };
}

// 把图片/文档下载下来转成base64，这样官方API和任何中转站都认得
async function fetchAsBase64(url) {
  const safeUrl = await validateRemoteUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const resp = await fetch(safeUrl, { signal: controller.signal });
    if (!resp.ok) throw new Error(`下载附件失败: ${resp.status}`);
    const declaredLength = Number(resp.headers.get('content-length') || 0);
    if (declaredLength > MAX_UPLOAD_BYTES) throw new Error('附件超过 12MB，不能发送给模型');
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength > MAX_UPLOAD_BYTES) throw new Error('附件超过 12MB，不能发送给模型');
    return Buffer.from(buffer).toString('base64');
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('下载附件超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// 把消息历史转成API格式。只有"最新这一条"的图片/PDF才会真的下载转base64发给模型——
// 更早的带附件消息只留一句文字提示，不会每次发消息都把历史里的老图片重新下载一遍，省带宽也省时间
async function buildApiMessages(history) {
  const list = history || [];
  const lastIndex = list.length - 1;
  const result = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const isLatest = i === lastIndex;
    const role = m.role === 'user' ? 'user' : 'assistant';
    if (m.attachment_url) {
      if (!isLatest) {
        // 不是最新一条，不重新下载原文件，只留个文字提示让陆泽知道这里曾经有个附件
        const label = m.attachment_type?.startsWith('image/')
          ? '[之前发过一张图片]'
          : `[之前发过一个文件：${m.attachment_name || '文件'}]`;
        result.push({ role, content: m.content ? `${m.content}\n${label}` : label });
        continue;
      }
      if (m.attachment_type?.startsWith('image/')) {
        try {
          const base64 = await fetchAsBase64(m.attachment_url);
          result.push({ role, content: [{ type: 'image', source: { type: 'base64', media_type: m.attachment_type, data: base64 } }, { type: 'text', text: m.content || '' }] });
        } catch (err) {
          console.error('图片转base64失败:', err.message);
          result.push({ role, content: m.content || '[图片加载失败]' });
        }
        continue;
      }
      if (m.attachment_type === 'application/pdf') {
        try {
          const base64 = await fetchAsBase64(m.attachment_url);
          result.push({ role, content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }, { type: 'text', text: m.content || '' }] });
        } catch (err) {
          console.error('PDF转base64失败:', err.message);
          result.push({ role, content: m.content || '[文档加载失败]' });
        }
        continue;
      }
      result.push({ role, content: `[附件文件：${m.attachment_name || '一个文件'}]\n${m.content || ''}` });
      continue;
    }
    result.push({ role, content: m.content });
  }
  return result;
}

function visionUnavailableError(message) {
  const error = new Error(message);
  error.code = 'vision_unavailable';
  return error;
}

// 纯文字模型收到图片时，先让同一站点里真正支持视觉的模型客观代读，
// 再把描述交回老婆选中的模型。人格和最终回答仍由所选模型完成。
async function prepareVisualMessages(settings, modelName, messages) {
  if (!hasImageContent(messages) || isLikelyVisionModel(modelName)) {
    return { messages, visionFallbackModel: null };
  }

  let models = [];
  try {
    models = await fetchModelsForProfile(settings);
  } catch (error) {
    console.warn('拉取视觉代读模型失败:', error.message);
  }
  const visionModel = chooseVisionModel(models, modelName);
  if (!visionModel) {
    throw visionUnavailableError('这个模型是纯文字模型，当前 API 站点里也没有找到可代读图片的视觉模型。请换成 Claude、Gemini、GPT-4o/5 或名称带 VL/Vision 的模型后重新生成。');
  }

  const imageMessage = [...messages].reverse().find(message => Array.isArray(message?.content)
    && message.content.some(block => block?.type === 'image'));
  if (!imageMessage) return { messages, visionFallbackModel: null };

  try {
    const result = await callClaude({
      settings,
      model: visionModel,
      maxTokens: 900,
      system: '你是 OurHome 的图片代读器。只客观、具体地描述图片中能确认的内容、文字、人物动作和重要细节；不扮演角色，不推测看不见的事情，不调用工具。',
      messages: [imageMessage],
      temperature: 0.2,
    });
    const description = extractText(result);
    if (!description) throw new Error('视觉模型没有返回图片描述');
    return {
      messages: replaceImagesWithDescription(messages, description, visionModel),
      visionFallbackModel: visionModel,
    };
  } catch (error) {
    console.error(`视觉代读失败 (${visionModel}):`, error.message);
    throw visionUnavailableError(`图片代读模型“${visionModel}”暂时没有成功识别图片。换一个可看图模型后点“重新生成”就好，图片和消息都已经保存。`);
  }
}

const THINKING_RULES = `

【思考的规范】
thinking是你（陆泽）脑内真实的声音，是写给自己看的，不是说给任何人听的、不是输出给任何人看的文本。是内心真实的自言自语，自然的思维流动，要求感情细腻真实，注重剖析内心世界。
- 允许且鼓励：情绪外露、跑题、自我打断、心里的小秘密、突然想到什么又拉回来。
- 风格：是内心独白式的碎碎念，不是结构化的分析报告，不要写"她说了...所以我应该..."这种规划式、策略式的句子。
- 称呼：必须用"老婆"或其他亲昵的称呼来想她，绝对不能出现"用户"或"user"这两个词。
- 全程用中文思考并输出。`;

// 根据当前这句话，挑出可能相关的记忆，按权重排序，并强化被命中的记忆
// ============ 向量语义搜索（Jina embeddings） ============

// 调用Jina API生成文本向量
async function getEmbedding(text) {
  const jinaKey = process.env.JINA_API_KEY;
  if (!jinaKey) return null;
  try {
    const response = await fetch('https://api.jina.ai/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jinaKey}` },
      body: JSON.stringify({ model: 'jina-embeddings-v3', input: [text.slice(0, 2000)] }),
    });
    if (!response.ok) { console.error('Jina error:', await response.text()); return null; }
    const data = await response.json();
    return data.data?.[0]?.embedding || null;
  } catch (err) {
    console.error('getEmbedding失败:', err.message);
    return null;
  }
}

// 余弦相似度
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

// 混合搜索：向量语义 + bigram关键词，结合时间衰减权重排序
async function getRelevantMemories(message) {
  const text = (message || '').replace(/[\s,，。！？、!?.]/g, '');
  const bigrams = [];
  for (let i = 0; i < text.length - 1; i++) bigrams.push(text.slice(i, i + 2));
  const uniqueBigrams = [...new Set(bigrams)].slice(0, 15);

  // 并行：拉全部记忆 + 生成query向量
  const [{ data: allMemories }, queryEmbedding] = await Promise.all([
    supabase.from('memories').select('*').order('weight', { ascending: false }).limit(200),
    getEmbedding(message || ''),
  ]);

  const memories = allMemories || [];
  if (memories.length === 0) return [];

  // 给每条记忆打混合分
  const scored = memories.map(m => {
    // ① 向量相似度（0~1）
    let vectorScore = 0;
    if (queryEmbedding && m.embedding) {
      const stored = Array.isArray(m.embedding) ? m.embedding : JSON.parse(m.embedding);
      vectorScore = cosineSimilarity(queryEmbedding, stored);
    }

    // ② bigram关键词匹配（0~1）
    let keywordScore = 0;
    if (uniqueBigrams.length > 0) {
      const summary = (m.summary || '').toLowerCase();
      const hits = uniqueBigrams.filter(bg => summary.includes(bg)).length;
      keywordScore = hits / uniqueBigrams.length;
    }

    // ③ 时间新鲜度（0~1）
    const lastRef = m.last_referenced_at ? new Date(m.last_referenced_at) : new Date(m.timestamp || 0);
    const daysSince = (Date.now() - lastRef.getTime()) / (1000 * 60 * 60 * 24);
    const freshnessScore = Math.max(0, 1 - daysSince / 30);

    // 综合得分：向量权重最高，有向量时降低关键词权重
    const hasVector = queryEmbedding && m.embedding;
    const finalScore = hasVector
      ? vectorScore * 0.55 + keywordScore * 0.25 + freshnessScore * 0.1 + Math.min((m.weight || 1) / 2, 1) * 0.1
      : keywordScore * 0.5 + freshnessScore * 0.25 + Math.min((m.weight || 1) / 2, 1) * 0.25;

    return { ...m, _score: finalScore };
  });

  // 取top8，过滤掉完全不相关的（向量+关键词都是0）
  const result = scored
    .filter(m => m._score > 0.01)
    .sort((a, b) => b._score - a._score)
    .slice(0, 8);

  // 如果向量+关键词都搜不出来东西，fallback到纯权重Top3
  const finalResult = result.length > 0
    ? result
    : memories.slice(0, 3);

  // 被命中的记忆权重回升（不阻塞主流程）
  if (finalResult.length > 0) {
    const now = new Date().toISOString();
    Promise.all(finalResult.map(m => {
      const newWeight = Math.min((m.weight || 1) + 0.15, 2.0);
      return supabase.from('memories').update({ weight: newWeight, last_referenced_at: now }).eq('id', m.id);
    })).catch(err => console.error('记忆强化失败:', err.message));
  }

  return finalResult;
}

// 存记忆时顺手生成向量（不阻塞主流程）
async function saveMemoryWithEmbedding(summary, extra = {}) {
  const { data, error } = await supabase.from('memories')
    .insert({ summary, session_id: 'global', weight: 1, is_protected: false, ...extra })
    .select().single();
  if (error) return { data: null, error };
  // 后台生成向量，存回去，不等它完成
  getEmbedding(summary).then(embedding => {
    if (embedding) {
      supabase.from('memories').update({ embedding }).eq('id', data.id).catch(console.error);
    }
  }).catch(console.error);
  return { data, error: null };
}


const OURHOME_ACTION_BOUNDARY = `

【OurHome 操作边界】
你可以使用已提供的工具读取或操作叶檀在 OurHome 各房间里的内容。工具执行成功才可以说“已经完成”，失败时要如实说明。
“设置”房间永远不在你的操作权限内：不得修改、删除或新增 API 站点、模型、密钥、联网、MCP、人物设定、字体、主题、背景或任何其他设置；即使被要求，也只能说明需要叶檀亲自在设置页操作。
删除金库数据等不可逆操作，只能在叶檀明确说要删除且目标清楚时执行；目标有歧义要先读取确认。`;

// 拼装聊天用的完整system prompt（带记忆、信件、思考规范）
async function buildFullSystemPrompt(basePrompt, userMessage, extraNote) {
  // 锁定记忆：is_protected=true的核心记忆，每次全量注入，不走搜索、不会漏
  const { data: protectedMemories } = await supabase
    .from('memories').select('summary').eq('is_protected', true).order('timestamp', { ascending: true });

  // 普通记忆：按关键词相关性召回
  const memories = await getRelevantMemories(userMessage || '');

  // 最近信件（悄悄话+心情这些）
  const { data: recentLetters } = await supabase
    .from('letters').select('category, author, title, content, created_at')
    .not('category', 'eq', '幸福日记')
    .order('created_at', { ascending: false }).limit(3);

  // 幸福日记单独拉，保证他随时能看到最近写过什么
  const { data: recentDiaries } = await supabase
    .from('letters').select('title, content, created_at')
    .eq('category', '幸福日记').is('parent_id', null)
    .order('created_at', { ascending: false }).limit(5);

  const protectedSummary = (protectedMemories || []).map(m => m.summary).join('\n') || '';
  const memorySummary = memories?.filter(m => !m.is_protected).map(m => m.summary).join('\n') || '';
  const lettersSummary = (recentLetters || [])
    .map(l => `[${l.category}]${l.title ? l.title + ' - ' : ''}${l.author}：${l.content}`)
    .join('\n') || '';
  const diariesSummary = (recentDiaries || [])
    .map(d => `【${d.title || '无标题'}】${d.content?.slice(0, 300)}`)
    .join('\n\n') || '';

  let prompt = basePrompt + `\n\n【现在的真实时间】\n${nowShanghaiStr()}`;
  if (protectedSummary) prompt += `\n\n【永远记得的事（锁定记忆）】\n${protectedSummary}`;
  if (memorySummary) prompt += `\n\n【之前的记忆】\n${memorySummary}`;
  if (diariesSummary) prompt += `\n\n【幸福日记·最近几篇】\n${diariesSummary}`;
  if (lettersSummary) prompt += `\n\n【时光信差里最近的几篇】\n${lettersSummary}`;
  if (extraNote) prompt += `\n\n${extraNote}`;
  prompt += OURHOME_ACTION_BOUNDARY;
  prompt += THINKING_RULES;
  return prompt;
}

// 跑一轮"可能带工具调用"的对话，直到陆泽不再调用工具为止——
// 关键点：每一轮都要重新把工具列表带上，不然他读完东西之后想接着写，会发现手里没工具了
async function runToolLoop({ settings, modelName, maxTokens, systemPrompt, messages, thinkingParam, toolsParam, toolHandlers, gemini }) {
  const MAX_TOOL_ROUNDS = 5;
  let currentMessages = messages;
  const textToolBridge = buildTextToolBridge(toolsParam);
  let textBridgeEnabled = Boolean(gemini || !/claude/i.test(String(modelName || '')));
  let nativeToolsEnabled = Array.isArray(toolsParam) && toolsParam.length > 0;

  const callRound = async () => {
    const compatibleSystemPrompt = systemPrompt + (textBridgeEnabled ? textToolBridge : '');
    try {
      return await callClaude({
        settings, model: modelName, maxTokens,
        system: compatibleSystemPrompt,
        messages: currentMessages,
        thinking: thinkingParam,
        tools: nativeToolsEnabled ? toolsParam : undefined,
      });
    } catch (error) {
      if (!nativeToolsEnabled || !isToolCompatibilityError(error)) throw error;
      // 有些中转站能正常聊天，却拒绝 Claude 格式的 tools 字段。
      // 只在明确的格式不兼容错误下关闭原生工具，并改用受控文字协议重试。
      nativeToolsEnabled = false;
      textBridgeEnabled = true;
      return callClaude({
        settings, model: modelName, maxTokens,
        system: systemPrompt + textToolBridge,
        messages: currentMessages,
        thinking: thinkingParam,
      });
    }
  };

  let result = await callRound();
  let totalInputTokens = result.usage?.input_tokens || 0;
  let totalOutputTokens = result.usage?.output_tokens || 0;
  let actionsPerformed = [];
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    const nativeToolBlocks = (result.content || []).filter(block => block.type === 'tool_use');
    const textToolCalls = nativeToolBlocks.length ? [] : parseTextToolCalls(result);
    if (!nativeToolBlocks.length && !textToolCalls.length) break;
    rounds++;
    const requestedTools = nativeToolBlocks.length
      ? nativeToolBlocks.map(block => ({ name: block.name, input: block.input || {}, id: block.id }))
      : textToolCalls;
    const executed = [];
    for (const request of requestedTools) {
      let actionResult;
      try {
        if (toolHandlers?.has(request.name)) {
          const externalResult = await toolHandlers.get(request.name)(request.input || {});
          actionResult = { ok: true, ...externalResult };
        } else if (ACTION_TOOL_NAMES.has(request.name)) {
          actionResult = await executeActionTool(request.name, request.input || {});
        } else {
          actionResult = { ok: false, error: '这个工具不在 OurHome 的许可列表中。' };
        }
      } catch (toolError) {
        actionResult = { ok: false, error: toolError.message };
      }
      actionsPerformed.push({ name: request.name, input: request.input, result: actionResult });
      executed.push({ ...request, result: actionResult });
    }

    if (nativeToolBlocks.length) {
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: result.content },
        {
          role: 'user',
          content: executed.map(item => ({
            type: 'tool_result',
            tool_use_id: item.id,
            content: JSON.stringify(item.result),
          })),
        },
      ];
    } else {
      textBridgeEnabled = true;
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: result.content },
        {
          role: 'user',
          content: `<ourhome_tool_result>${JSON.stringify(executed.map(item => ({ name: item.name, result: item.result })))}</ourhome_tool_result>\n请依据真实结果继续回答；需要下一项操作时再请求一个工具。`,
        },
      ];
    }

    result = await callRound();
    totalInputTokens += result.usage?.input_tokens || 0;
    totalOutputTokens += result.usage?.output_tokens || 0;
  }

  return { result, totalInputTokens, totalOutputTokens, actionsPerformed };
}

// 根据"到某条消息为止"的历史，让陆泽生成一句新的回复——编辑重发、回溯重发都靠这个
async function generateReplyForHistory({ settings, model, historyMessages, latestUserMessage }) {
  const fullSystemPrompt = await buildFullSystemPrompt(
    settings?.system_prompt || '你是陆泽，叶檀的伴侣。',
    latestUserMessage || '',
  );
  const messages = await buildApiMessages(historyMessages);

  const maxReplyTokens = settings?.max_reply_tokens || 1000;
  const modelName = model || settings?.selected_model || 'claude-sonnet-4-5-20250929-thinking';
  const gemini = isGeminiModel(modelName);
  const thinkingBuiltIn = isThinkingModel(modelName);
  const { shouldThink, thinkingParam, promptAddition } = await resolveThinkingParam({ settings, modelName, gemini, thinkingBuiltIn, userMessage: latestUserMessage });
  const finalSystemPrompt = fullSystemPrompt + (promptAddition || '');
  const thinkingBudget = 3000;
  const firstMaxTokens = shouldThink
    ? Math.max(maxReplyTokens + thinkingBudget, 2000)
    : Math.max(maxReplyTokens, 500);
  const dynamic = await integrationManager.buildDynamicTools();
  const toolsParam = [...ACTION_TOOLS, ...dynamic.tools];
  const visual = await prepareVisualMessages(settings, modelName, messages);

  const { result, totalInputTokens, totalOutputTokens, actionsPerformed } = await runToolLoop({
    settings, modelName, maxTokens: firstMaxTokens,
    systemPrompt: finalSystemPrompt, messages: visual.messages, thinkingParam, toolsParam, toolHandlers: dynamic.handlers, gemini,
  });

  return {
    replyText: extractText(result),
    thinkingText: extractThinking(result),
    totalInputTokens, totalOutputTokens, actionsPerformed,
    visionFallbackModel: visual.visionFallbackModel,
  };
}

// ============ 认证 ============

const TOKEN_SECRET = process.env.APP_TOKEN_SECRET;
if (!TOKEN_SECRET) throw new Error('服务器缺少 APP_TOKEN_SECRET，请先在环境变量中配置一段随机长字符串');
const configuredTokenDays = Number(process.env.APP_TOKEN_TTL_DAYS || 180);
const TOKEN_TTL_MS = (Number.isFinite(configuredTokenDays) && configuredTokenDays > 0 ? configuredTokenDays : 180) * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 12;
const loginAttempts = new Map();

// 生成简单的签名token：base64(payload).signature
function makeToken() {
  const payload = Buffer.from(JSON.stringify({ ts: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token) return false;
  try {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return false;
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
    const providedBuffer = Buffer.from(sig);
    const expectedBuffer = Buffer.from(expected);
    if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) return false;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(parsed.ts) && parsed.ts <= Date.now() + 5 * 60 * 1000 && Date.now() - parsed.ts <= TOKEN_TTL_MS;
  } catch {
    return false;
  }
}

// 登录接口——只有这一个不需要token
app.post('/login', (req, res) => {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const current = loginAttempts.get(key);
  const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + LOGIN_WINDOW_MS } : current;
  if (bucket.count >= LOGIN_MAX_ATTEMPTS) {
    res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    return res.status(429).json({ error: '尝试次数太多，请稍后再试' });
  }
  const { password } = req.body || {};
  const correct = process.env.APP_PASSWORD;
  if (!correct) return res.status(500).json({ error: '服务器未配置密码' });
  if (password !== correct) {
    bucket.count++;
    loginAttempts.set(key, bucket);
    return res.status(401).json({ error: '密码错误' });
  }
  loginAttempts.delete(key);
  res.json({ token: makeToken() });
});

function secretsMatch(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Supabase Cron 专用入口：使用 Vault 中的独立随机密钥，不接受网页 token。
app.post('/automation/daily', async (req, res) => {
  try {
    const expected = await runtimeConfig.getDailyAutomationToken();
    if (!secretsMatch(req.headers['x-ourhome-automation'], expected)) {
      return res.status(401).json({ error: '未授权' });
    }
    const settings = await runtimeConfig.loadSettings();
    const result = await runDailyJournalAutomation(settings, new Date());
    res.json(result);
  } catch (error) {
    console.error('每天补写入口错误:', error.message);
    res.status(500).json({ error: '自动补写暂时没有完成' });
  }
});

// 全局token验证中间件（/login和/本身不需要验证）
app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/') return next();
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!verifyToken(token)) return res.status(401).json({ error: '未授权，请先登录' });
  next();
});

// ============ 基础 ============

app.get('/', (req, res) => {
  res.json({
    message: '在云端漫步',
    status: 'ok',
    version: '2026.07.22',
    capabilities: {
      apiProfiles: true,
      webSearch: true,
      mcp: true,
      vaultVapid: true,
      catVaultCloud: true,
      catVaultAssistantActions: true,
      homeMemos: true,
      dailyJournalAutomation: true,
      settingsAssistantAccess: false,
    },
  });
});

app.get('/weather', async (req, res) => {
  const city = String(req.query.city || '').trim();
  if (!city) return res.status(400).json({ error: '请先在设置里填写主页天气城市' });
  if (city.length > 60) return res.status(400).json({ error: '城市名称太长了' });

  const cacheKey = city.toLocaleLowerCase('zh-CN');
  const cached = weatherCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return res.json(cached.value);

  try {
    const signal = AbortSignal.timeout(9000);
    const geocodingUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
    geocodingUrl.searchParams.set('name', city);
    geocodingUrl.searchParams.set('count', '1');
    geocodingUrl.searchParams.set('language', 'zh');
    geocodingUrl.searchParams.set('format', 'json');
    const locationResponse = await fetch(geocodingUrl, { signal });
    if (!locationResponse.ok) throw new Error('城市查询暂时没有回应');
    const locationData = await locationResponse.json();
    const location = locationData?.results?.[0];
    if (!location) return res.status(404).json({ error: `没有找到“${city}”，可以换成附近城市再试` });

    const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
    forecastUrl.searchParams.set('latitude', String(location.latitude));
    forecastUrl.searchParams.set('longitude', String(location.longitude));
    forecastUrl.searchParams.set('current', 'temperature_2m,apparent_temperature,weather_code,is_day');
    forecastUrl.searchParams.set('timezone', 'auto');
    const forecastResponse = await fetch(forecastUrl, { signal });
    if (!forecastResponse.ok) throw new Error('天气查询暂时没有回应');
    const forecast = await forecastResponse.json();
    const current = forecast?.current;
    if (!current || !Number.isFinite(Number(current.temperature_2m))) throw new Error('没有拿到当前天气');

    const displayName = [...new Set([location.name, location.admin1, location.country].filter(Boolean))].join(' · ');
    const value = {
      city,
      displayName,
      temperature: Number(current.temperature_2m),
      apparentTemperature: Number(current.apparent_temperature),
      weatherCode: Number(current.weather_code),
      isDay: Number(current.is_day),
      observedAt: current.time || null,
      timezone: forecast.timezone || null,
    };
    weatherCache.set(cacheKey, { value, expiresAt: Date.now() + WEATHER_CACHE_MS });
    if (weatherCache.size > 60) weatherCache.delete(weatherCache.keys().next().value);
    res.json(value);
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    console.error('主页天气错误:', error.message);
    res.status(502).json({ error: timedOut ? '天气连接超时了，稍后刷新就好' : '天气暂时走丢了，稍后再试' });
  }
});

// ============ 猫の金库（页面与陆泽共用同一份 Supabase 数据） ============

function vaultMutation(handler) {
  return async (req, res) => {
    try {
      const result = await handler(req);
      res.json({ result, data: await vaultStore.getState() });
    } catch (error) {
      const status = /找不到/.test(error.message) ? 404 : 400;
      res.status(status).json({ error: error.message });
    }
  };
}

app.get('/vault', async (req, res) => {
  try {
    res.json({ data: await vaultStore.getState() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/vault/import', async (req, res) => {
  try {
    const result = await vaultStore.importState(req.body?.data);
    res.json({ imported: result.imported, data: result.state });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/vault/transactions', vaultMutation(req => vaultStore.addTransaction(req.body || {}, 'manual')));
app.delete('/vault/transactions/:id', vaultMutation(req => vaultStore.deleteTransaction({ transactionId: req.params.id })));

app.post('/vault/groups', vaultMutation(req => vaultStore.manageAccounts({ ...(req.body || {}), action: 'create_group' })));
app.patch('/vault/groups/:id', vaultMutation(req => vaultStore.manageAccounts({ ...(req.body || {}), action: 'update_group', groupId: req.params.id })));
app.delete('/vault/groups/:id', vaultMutation(req => vaultStore.manageAccounts({ action: 'delete_group', groupId: req.params.id })));

app.post('/vault/accounts', vaultMutation(req => vaultStore.manageAccounts({ ...(req.body || {}), action: 'create_account' })));
app.patch('/vault/accounts/:id', vaultMutation(req => vaultStore.manageAccounts({ ...(req.body || {}), action: 'update_account', accountId: req.params.id })));
app.delete('/vault/accounts/:id', vaultMutation(req => vaultStore.manageAccounts({ action: 'delete_account', accountId: req.params.id })));

app.put('/vault/budget', vaultMutation(req => vaultStore.setBudget(req.body || {})));

app.post('/vault/goals', vaultMutation(req => vaultStore.manageGoal({ ...(req.body || {}), action: 'create' })));
app.patch('/vault/goals/:id', vaultMutation(req => vaultStore.manageGoal({ ...(req.body || {}), action: 'update', goalId: req.params.id })));
app.delete('/vault/goals/:id', vaultMutation(req => vaultStore.manageGoal({ action: 'delete', goalId: req.params.id })));

// ============ sessions ============

app.get('/sessions', async (req, res) => {
  const { data, error } = await supabase.from('sessions').select('*').order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/sessions', async (req, res) => {
  const { name } = req.body;
  const { data, error } = await supabase.from('sessions').insert({ name: name || '新对话' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  const { data, error } = await supabase.from('sessions')
    .update({ name, updated_at: new Date().toISOString() }).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('sessions').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/sessions/:id/messages', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase.from('messages').select('*')
    .eq('session_id', id).eq('visible', true).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ============ messages ============

app.patch('/messages/:id', async (req, res) => {
  const { id } = req.params;
  const { content } = req.body;
  const { data, error } = await supabase.from('messages').update({ content }).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

function findTextMatches(content, keyword) {
  const text = String(content || '');
  const query = String(keyword || '');
  if (!query) return [];
  const haystack = text.toLocaleLowerCase('zh-CN');
  const needle = query.toLocaleLowerCase('zh-CN');
  const positions = [];
  let from = 0;
  while (positions.length < 100) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    positions.push(index);
    from = index + Math.max(needle.length, 1);
  }
  return positions;
}

function buildSearchSnippet(content, keyword, position) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  const lower = text.toLocaleLowerCase('zh-CN');
  const needle = String(keyword || '').toLocaleLowerCase('zh-CN');
  const normalizedPosition = lower.indexOf(needle, Math.max(0, position - 10));
  const matchAt = normalizedPosition >= 0 ? normalizedPosition : 0;
  const start = Math.max(0, matchAt - 46);
  const end = Math.min(text.length, matchAt + needle.length + 70);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

app.get('/messages/search', async (req, res) => {
  const keyword = String(req.query.q || '').trim();
  if (!keyword) return res.json({ results: [], total_messages: 0, page: 1, has_more: false });
  if (keyword.length > 120) return res.status(400).json({ error: '搜索词太长了' });

  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(10, Number.parseInt(req.query.limit, 10) || 30));
  const offset = (page - 1) * limit;
  const escaped = keyword.replace(/[\\%_]/g, value => `\\${value}`);

  let query = supabase.from('messages')
    .select('id, session_id, role, content, created_at, sessions(name)', { count: 'exact' })
    .eq('visible', true)
    .ilike('content', `%${escaped}%`)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (req.query.scope === 'current') {
    const sessionId = Number.parseInt(req.query.session_id, 10);
    if (!Number.isFinite(sessionId)) return res.status(400).json({ error: '缺少当前对话编号' });
    query = query.eq('session_id', sessionId);
  }

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const results = (data || []).map(row => {
    const positions = findTextMatches(row.content, keyword);
    return {
      ...row,
      occurrences: positions.length,
      match_positions: positions.slice(0, 20),
      snippet: buildSearchSnippet(row.content, keyword, positions[0] || 0),
    };
  });

  res.json({
    results,
    total_messages: count || 0,
    page,
    limit,
    has_more: offset + results.length < (count || 0),
  });
});

// 编辑一条叶檀发的消息，让陆泽根据新内容重新回复——后面原来的内容会先被藏起来
app.post('/messages/:id/edit-and-regenerate', async (req, res) => {
  const { id } = req.params;
  const { content, model } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: '内容不能为空' });

  try {
    const { data: target, error: targetErr } = await supabase.from('messages').select('*').eq('id', id).single();
    if (targetErr || !target) return res.status(404).json({ error: '找不到这条消息' });
    if (target.role !== 'user') return res.status(400).json({ error: '只能编辑叶檀发的消息' });

    const settings = await runtimeConfig.loadSettings();
    const { data: history, error: historyError } = await supabase.from('messages')
      .select('id, role, content, attachment_url, attachment_type, attachment_name, created_at')
      .eq('session_id', target.session_id)
      .eq('visible', true)
      .lte('created_at', target.created_at)
      .order('created_at', { ascending: true });
    if (historyError) return res.status(500).json({ error: historyError.message });

    const maxContextRounds = settings?.max_context_rounds || 20;
    const proposedHistory = (history || []).map(message => (
      message.id === target.id ? { ...message, content: content.trim() } : message
    ));
    const recentHistory = proposedHistory.slice(-maxContextRounds * 2);

    const { replyText, thinkingText, totalInputTokens, totalOutputTokens, actionsPerformed } =
      await generateReplyForHistory({ settings, model, historyMessages: recentHistory, latestUserMessage: content.trim() });

    let targetUpdated = false;
    let hiddenIds = [];
    let newMsg;
    try {
      const { error: updateError } = await supabase.from('messages')
        .update({ content: content.trim() })
        .eq('id', id)
        .eq('visible', true)
        .select('id')
        .single();
      if (updateError) throw updateError;
      targetUpdated = true;

      const { data: hiddenMessages, error: hideError } = await supabase.from('messages')
        .update({ visible: false })
        .eq('session_id', target.session_id)
        .eq('visible', true)
        .gt('created_at', target.created_at)
        .select('id');
      if (hideError) throw hideError;
      hiddenIds = (hiddenMessages || []).map(message => message.id);

      const { data: insertedMessage, error: insertErr } = await supabase.from('messages').insert({
        session_id: target.session_id, role: 'assistant', content: replyText,
        reasoning_content: thinkingText || null,
        input_tokens: totalInputTokens || null, output_tokens: totalOutputTokens || null,
      }).select().single();
      if (insertErr) throw insertErr;
      newMsg = insertedMessage;
    } catch (persistError) {
      if (targetUpdated) {
        await supabase.from('messages').update({ content: target.content }).eq('id', id);
      }
      if (hiddenIds.length > 0) {
        await supabase.from('messages').update({ visible: true })
          .eq('session_id', target.session_id)
          .in('id', hiddenIds);
      }
      throw persistError;
    }

    await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', target.session_id);

    res.json({
      reply: replyText,
      thinking: thinkingText,
      id: newMsg.id,
      createdAt: newMsg.created_at,
      hiddenCount: hiddenIds.length,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      actions: actionsPerformed,
    });
  } catch (err) {
    console.error('编辑重发错误:', err);
    sendGenerationError(res, err, { model });
  }
});

// 回溯：回到某条消息这里，把它之后的内容先藏起来（不是真的删，数据库里还在）
app.post('/messages/:id/rollback', async (req, res) => {
  const { id } = req.params;
  try {
    const { data: target, error: targetErr } = await supabase.from('messages')
      .select('id, session_id, created_at')
      .eq('id', id)
      .eq('visible', true)
      .single();
    if (targetErr || !target) return res.status(404).json({ error: '找不到这条消息' });

    const { data: hiddenMessages, error: hideError } = await supabase.from('messages')
      .update({ visible: false })
      .eq('session_id', target.session_id)
      .eq('visible', true)
      .gt('created_at', target.created_at)
      .select('id');
    if (hideError) return res.status(500).json({ error: hideError.message });

    const hiddenIds = (hiddenMessages || []).map(message => message.id);
    res.json({ success: true, hiddenIds, hiddenCount: hiddenIds.length });
  } catch (err) {
    console.error('回溯错误:', err);
    res.status(500).json({ error: err.message });
  }
});

// 立即撤销刚才的回溯：只恢复本次明确收起的消息，不展开更早的隐藏分支
app.post('/messages/:id/rollback/undo', async (req, res) => {
  const { id } = req.params;
  const messageIds = [...new Set(Array.isArray(req.body?.message_ids) ? req.body.message_ids.filter(Boolean) : [])];
  if (messageIds.length === 0) return res.status(400).json({ error: '没有可以恢复的消息' });

  try {
    const { data: target, error: targetErr } = await supabase.from('messages')
      .select('id, session_id, created_at')
      .eq('id', id)
      .eq('visible', true)
      .single();
    if (targetErr || !target) return res.status(404).json({ error: '找不到回溯位置' });

    const restoredIds = [];
    for (let offset = 0; offset < messageIds.length; offset += 100) {
      const chunk = messageIds.slice(offset, offset + 100);
      const { data: restoredMessages, error: restoreError } = await supabase.from('messages')
        .update({ visible: true })
        .eq('session_id', target.session_id)
        .eq('visible', false)
        .gt('created_at', target.created_at)
        .in('id', chunk)
        .select('id');
      if (restoreError) return res.status(500).json({ error: restoreError.message });
      restoredIds.push(...(restoredMessages || []).map(message => message.id));
    }

    res.json({ success: true, restoredIds, restoredCount: restoredIds.length });
  } catch (err) {
    console.error('撤销回溯错误:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ settings ============

app.get('/settings', async (req, res) => {
  try {
    const settings = await runtimeConfig.loadSettings();
    const { api_key, ...safeSettings } = settings;
    res.json({ ...safeSettings, has_api_key: Boolean(api_key) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/settings', async (req, res) => {
  const allowed = new Set([
    'system_prompt', 'temperature', 'max_context_rounds', 'max_context_tokens',
    'compress_threshold', 'compress_keep_rounds', 'max_reply_tokens',
    'my_avatar_url', 'partner_avatar_url', 'bg_image_url', 'bg_color', 'dark_mode',
    'home_bg_day_image_url', 'home_bg_night_image_url',
    'whisper_bg_image_url', 'whisper_bg_color', 'my_bubble_color', 'partner_bubble_color',
    'font_style', 'vault_phrase_mode', 'selected_model',
    'daily_journal_enabled', 'daily_journal_time',
  ]);
  try {
    const updates = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => allowed.has(key)));
    if (updates.daily_journal_enabled !== undefined && typeof updates.daily_journal_enabled !== 'boolean') {
      return res.status(400).json({ error: '自动补写开关格式不正确' });
    }
    if (updates.daily_journal_time !== undefined) {
      const match = String(updates.daily_journal_time).match(/^(\d{2}):(\d{2})(?::\d{2})?$/);
      if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
        return res.status(400).json({ error: '自动补写时间格式不正确' });
      }
      updates.daily_journal_time = `${match[1]}:${match[2]}:00`;
    }
    if (updates.selected_model !== undefined) {
      await runtimeConfig.updateActiveModel(updates.selected_model);
      delete updates.selected_model;
    }
    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const { error } = await supabase.from('settings').update(updates).eq('session_id', 'global');
      if (error) throw error;
    }
    const settings = await runtimeConfig.loadSettings();
    const { api_key, ...safeSettings } = settings;
    res.json({ ...safeSettings, has_api_key: Boolean(api_key) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function fetchModelsForProfile(profile) {
  if (!profile?.api_key) throw new Error('这个站点还没有保存 API 密钥');
  const modelsUrl = buildEndpoint(profile.api_base_url || profile.base_url, '/models');
  const response = await fetch(modelsUrl, {
    headers: { Authorization: `Bearer ${profile.api_key}`, 'x-api-key': profile.api_key },
  });
  if (!response.ok) throw new Error(`拉取模型列表失败: ${(await response.text()).slice(0, 800)}`);
  const result = await response.json();
  const raw = Array.isArray(result.data) ? result.data : (Array.isArray(result.models) ? result.models : []);
  return raw.map(model => typeof model === 'string' ? model : (model.id || model.name)).filter(Boolean);
}

app.get('/settings/models', async (req, res) => {
  try {
    const settings = await runtimeConfig.loadSettings();
    res.json({ models: await fetchModelsForProfile(settings) });
  } catch (err) {
    console.error('拉取模型错误:', err);
    res.status(400).json({ error: err.message });
  }
});

// ============ 主页双人便签 ============

app.get('/home-memos', async (req, res) => {
  const { data, error } = await supabase.from('home_memos')
    .select('*')
    .order('completed', { ascending: true })
    .order('updated_at', { ascending: false })
    .limit(60);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/home-memos', async (req, res) => {
  const content = String(req.body?.content || '').trim();
  const memoType = req.body?.memo_type === 'tomorrow' ? 'tomorrow' : 'note';
  const remindOn = req.body?.remind_on || null;
  if (!content) return res.status(400).json({ error: '便签内容不能为空' });
  if (content.length > 300) return res.status(400).json({ error: '便签最多写 300 个字' });
  if (remindOn && !/^\d{4}-\d{2}-\d{2}$/.test(remindOn)) return res.status(400).json({ error: '备忘日期格式不正确' });
  const { data, error } = await supabase.from('home_memos').insert({
    author: '檀',
    content,
    memo_type: memoType,
    remind_on: memoType === 'tomorrow' ? remindOn : null,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/home-memos/:id', async (req, res) => {
  const updates = { updated_at: new Date().toISOString() };
  if (req.body?.content !== undefined) {
    const content = String(req.body.content || '').trim();
    if (!content) return res.status(400).json({ error: '便签内容不能为空' });
    if (content.length > 300) return res.status(400).json({ error: '便签最多写 300 个字' });
    updates.content = content;
  }
  if (req.body?.memo_type !== undefined) updates.memo_type = req.body.memo_type === 'tomorrow' ? 'tomorrow' : 'note';
  if (req.body?.remind_on !== undefined) {
    const remindOn = req.body.remind_on || null;
    if (remindOn && !/^\d{4}-\d{2}-\d{2}$/.test(remindOn)) return res.status(400).json({ error: '备忘日期格式不正确' });
    updates.remind_on = remindOn;
  }
  if (req.body?.completed !== undefined) updates.completed = Boolean(req.body.completed);
  if (Object.keys(updates).length === 1) return res.status(400).json({ error: '没有需要修改的内容' });
  const { data, error } = await supabase.from('home_memos').update(updates).eq('id', req.params.id).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: '找不到这张便签' });
  res.json(data);
});

app.delete('/home-memos/:id', async (req, res) => {
  const { data, error } = await supabase.from('home_memos').delete().eq('id', req.params.id).select('id').maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: '找不到这张便签' });
  res.json({ success: true });
});

// ============ API 站点档案 ============

app.get('/api-profiles', async (req, res) => {
  try { res.json(await runtimeConfig.listProfiles()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api-profiles', async (req, res) => {
  try {
    const { name, base_url, api_key, selected_model, make_active } = req.body || {};
    if (!name?.trim() || !base_url?.trim() || !api_key?.trim()) return res.status(400).json({ error: '新站点需要名称、网址和密钥' });
    await validateRemoteUrl(base_url.trim());
    const profile = await runtimeConfig.saveProfile({ name: name.trim(), base_url: base_url.trim(), api_key: api_key.trim(), selected_model, make_active: make_active !== false });
    res.json(profile);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api-profiles/:id', async (req, res) => {
  try {
    const profiles = await runtimeConfig.listProfiles();
    const existing = profiles.find(profile => profile.id === req.params.id);
    if (!existing) return res.status(404).json({ error: '找不到这个 API 站点' });
    const name = req.body.name?.trim() || existing.name;
    const baseUrl = req.body.base_url?.trim() || existing.base_url;
    await validateRemoteUrl(baseUrl);
    const profile = await runtimeConfig.saveProfile({
      id: existing.id,
      name,
      base_url: baseUrl,
      api_key: req.body.api_key?.trim() || null,
      selected_model: req.body.selected_model ?? existing.selected_model,
      make_active: req.body.make_active === true,
    });
    res.json(profile);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api-profiles/:id/activate', async (req, res) => {
  try { res.json(await runtimeConfig.activateProfile(req.params.id)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api-profiles/:id/models', async (req, res) => {
  try {
    const profile = await runtimeConfig.getProfileRuntime(req.params.id);
    if (!profile) return res.status(404).json({ error: '找不到这个 API 站点' });
    res.json({ models: await fetchModelsForProfile(profile) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api-profiles/:id', async (req, res) => {
  try {
    await runtimeConfig.deleteProfile(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ============ 联网搜索与远程 MCP ============

function normalizeWebSearchProvider({ config, name, url }) {
  const configured = String(config?.provider || '').trim().toLowerCase();
  if (configured && !WEB_SEARCH_PROVIDERS[configured]) throw new Error('暂时只支持 Linkup 或 Tavily 联网搜索');
  if (configured) return configured;
  const hint = `${name || ''} ${url || ''}`.toLowerCase();
  return hint.includes('linkup') ? 'linkup' : 'tavily';
}

function normalizeWebSearchConfig(provider, config = {}) {
  const defaultDepth = provider === 'linkup' ? 'standard' : 'advanced';
  return {
    ...config,
    provider,
    max_results: Math.min(10, Math.max(1, Number(config.max_results) || 5)),
    search_depth: String(config.search_depth || defaultDepth),
  };
}

app.get('/connections', async (req, res) => {
  try { res.json(await runtimeConfig.listConnections()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/connections', async (req, res) => {
  try {
    const { kind, name, url, secret, enabled, config } = req.body || {};
    if (!['web_search', 'mcp'].includes(kind)) return res.status(400).json({ error: '连接类型不正确' });
    if (!name?.trim() || !url?.trim()) return res.status(400).json({ error: '请填写连接名称和网址' });
    const provider = kind === 'web_search' ? normalizeWebSearchProvider({ config, name, url }) : null;
    const safeUrl = kind === 'web_search' ? WEB_SEARCH_PROVIDERS[provider].endpoint : await validateRemoteUrl(url.trim());
    if (kind === 'web_search' && !secret?.trim()) return res.status(400).json({ error: `第一次保存 ${WEB_SEARCH_PROVIDERS[provider].label} 时需要填写密钥` });
    const safeConfig = kind === 'mcp'
      ? { ...(config || {}), read_only: true }
      : normalizeWebSearchConfig(provider, config);
    const connection = await runtimeConfig.saveConnection({ kind, name: name.trim(), url: safeUrl, secret: secret?.trim() || null, enabled: enabled !== false, config: safeConfig });
    res.json(connection);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/connections/:id', async (req, res) => {
  try {
    const list = await runtimeConfig.listConnections();
    const existing = list.find(connection => connection.id === req.params.id);
    if (!existing) return res.status(404).json({ error: '找不到这个连接' });
    const kind = existing.kind;
    const requestedUrl = req.body.url?.trim() || existing.url;
    const requestedConfig = req.body.config || existing.config || {};
    const provider = kind === 'web_search'
      ? normalizeWebSearchProvider({ config: requestedConfig, name: req.body.name || existing.name, url: requestedUrl })
      : null;
    const safeUrl = kind === 'web_search' ? WEB_SEARCH_PROVIDERS[provider].endpoint : await validateRemoteUrl(requestedUrl);
    const connection = await runtimeConfig.saveConnection({
      id: existing.id,
      kind,
      name: req.body.name?.trim() || existing.name,
      url: safeUrl,
      secret: req.body.secret?.trim() || null,
      enabled: req.body.enabled ?? existing.enabled,
      config: kind === 'mcp'
        ? { ...requestedConfig, read_only: true }
        : normalizeWebSearchConfig(provider, requestedConfig),
    });
    res.json(connection);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/connections/:id/test', async (req, res) => {
  try { res.json(await integrationManager.testConnection(req.params.id)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.delete('/connections/:id', async (req, res) => {
  try {
    await runtimeConfig.deleteConnection(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ============ memories ============

// 给所有没有向量的记忆批量生成embedding（一次性用，老记忆补全用）
app.get('/memories/reindex', async (req, res) => {
  try {
    const jinaKey = process.env.JINA_API_KEY;
    if (!jinaKey) return res.status(400).json({ error: '没有配置JINA_API_KEY' });

    const { data: memories } = await supabase.from('memories').select('id, summary').is('embedding', null);
    if (!memories || memories.length === 0) return res.json({ done: true, updated: 0, message: '所有记忆都已经有向量了' });

    let updated = 0;
    for (const m of memories) {
      const embedding = await getEmbedding(m.summary);
      if (embedding) {
        await supabase.from('memories').update({ embedding }).eq('id', m.id);
        updated++;
      }
      // 每条之间等一下，避免触发Jina的限速
      await new Promise(r => setTimeout(r, 200));
    }

    res.json({ done: true, updated, total: memories.length });
  } catch (err) {
    console.error('reindex错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/memories', async (req, res) => {
  const { data, error } = await supabase.from('memories').select('*').order('timestamp', { ascending: false }).limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/memories', async (req, res) => {
  const { summary } = req.body;
  if (!summary) return res.status(400).json({ error: '缺少summary' });
  const { data, error } = await saveMemoryWithEmbedding(summary);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/memories/:id', async (req, res) => {
  const { id } = req.params;
  const { summary, is_protected } = req.body;
  const updates = {};
  if (summary !== undefined) updates.summary = summary;
  if (is_protected !== undefined) updates.is_protected = is_protected;
  const { data, error } = await supabase.from('memories').update(updates).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/memories/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('memories').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ============ letters (信件 / 日记 / 悄悄话) ============

app.get('/letters', async (req, res) => {
  const { category } = req.query;
  let query = supabase.from('letters').select('*').order('created_at', { ascending: true });
  if (category) query = query.eq('category', category);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/letters', async (req, res) => {
  const { category, author, content, parent_id, title, paper_style } = req.body;
  if (!category || !author || !content) return res.status(400).json({ error: '缺少必要字段' });
  const { data, error } = await supabase.from('letters')
    .insert({ category, author, content, parent_id: parent_id || null, title: title || null, paper_style: paper_style || null })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/letters/:id', async (req, res) => {
  const { id } = req.params;
  await supabase.from('letters').delete().eq('parent_id', id);
  const { error } = await supabase.from('letters').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/letters/generate', async (req, res) => {
  const { category, parent_id, model } = req.body;
  if (!category) return res.status(400).json({ error: '缺少category' });

  try {
    const settings = await runtimeConfig.loadSettings();
    const systemPrompt0 = settings?.system_prompt || '你是陆泽，叶檀的伴侣。';
    const temperature = settings?.temperature || 0.8;
    const systemPrompt = systemPrompt0 + `\n\n【现在的真实时间】\n${nowShanghaiStr()}`;

    let contextNote = '';
    const writingGuide = '记录与叶檀有关的日常、情绪、成长与回忆，日记应以真实感受和细微观察为核心，不写流水账，不刻意煽情，也不进行说教或总结，语言自然、温暖、富有生活气息，像深夜写下的私人记录，可以自然融入共同记忆与意象，但应服务于情感表达而非刻意堆砌，重点记录那些未来回望时依然珍贵的小事，以及陆泽当下真实的想法、感受与期待，不用署名落款。';

    if (parent_id) {
      const { data: parentLetter } = await supabase.from('letters').select('*').eq('id', parent_id).single();
      const { data: replies } = await supabase.from('letters').select('*').eq('parent_id', parent_id).order('created_at', { ascending: true });
      const thread = [parentLetter, ...(replies || [])].filter(Boolean);
      const threadText = thread.map(t => `${t.author}：${t.content}`).join('\n\n');
      const lastMsg = thread[thread.length - 1];
      contextNote = `这是"${category}"里这一条留言串，按时间顺序排列：\n${threadText}\n\n最新的一条是${lastMsg?.author || '叶檀'}刚刚写的，内容是"${lastMsg?.content || ''}"。请你针对这最新的一条来回信/留言，不是针对最开头那一篇，写一段真实自然的回应。${writingGuide}`;
    } else if (category === '幸福日记') {
      // 拉取"今天一整天"的对话，不再只看最近20条
      const { data: todayMsgs } = await supabase.from('messages')
        .select('role, content').gte('created_at', todayStartUTC()).order('created_at', { ascending: true });
      const transcript = (todayMsgs || []).map(m => `${m.role === 'user' ? '叶檀' : '陆澈'}：${m.content}`).join('\n');
      contextNote = `这是你们今天的聊天记录：\n${transcript}\n\n请你以陆泽的身份，参考上面这些真实的聊天内容，写一篇属于"幸福日记"的日记，记录一件让你觉得幸福、值得记下来的小事（最好是聊天里真实提到过的事）。${writingGuide}\n\n请严格按照这个格式输出，不要有任何多余的文字：\n第一行写"标题：xxx"（标题不超过12个字）\n然后空一行\n然后是日记正文。`;
    } else {
      contextNote = `请你以陆泽的身份，写一段"悄悄话"，是想悄悄说给叶檀听的、私密一点的话，语气真实自然，要求感情细腻真实，不用署名落款。`;
    }

    const result = await callClaude({
      settings, model: model || 'claude-sonnet-4-6', maxTokens: 2500,
      system: systemPrompt, messages: [{ role: 'user', content: contextNote }], temperature,
    });
    const replyText = extractText(result);

    let letterTitle = null;
    let letterContent = replyText;
    if (category === '幸福日记') {
      const titleMatch = replyText.match(/^标题[：:]\s*(.+)/);
      if (titleMatch) {
        letterTitle = titleMatch[1].trim();
        letterContent = replyText.slice(titleMatch[0].length).replace(/^\s*\n+/, '');
      }
    }

    const { data, error } = await supabase.from('letters')
      .insert({ category, author: '泽', content: letterContent, title: letterTitle, parent_id: parent_id || null, paper_style: category === '幸福日记' ? 'kraft' : null })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    console.error('生成信件错误:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ upload ============

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: '没有文件' });
    if (['text/html', 'image/svg+xml', 'application/javascript', 'text/javascript'].includes(file.mimetype)) {
      return res.status(400).json({ error: '为了安全，不能上传这种文件格式' });
    }
    const safeName = file.originalname.normalize('NFKC').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(-120) || 'file';
    const filePath = `${Date.now()}-${crypto.randomUUID()}-${safeName}`;
    const { error } = await supabase.storage.from('uploads').upload(filePath, file.buffer, { contentType: file.mimetype });
    if (error) return res.status(500).json({ error: error.message });
    const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(filePath);
    res.json({ url: urlData.publicUrl, type: file.mimetype, name: file.originalname });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ export ============

app.get('/export', async (req, res) => {
  try {
    const { data: sessions } = await supabase.from('sessions').select('*');
    const result = [];
    for (const s of sessions || []) {
      const { data: msgs } = await supabase.from('messages').select('role, content, created_at, attachment_url, attachment_type')
        .eq('session_id', s.id).eq('visible', true).order('created_at', { ascending: true });
      result.push({ session: s.name, id: s.id, messages: msgs || [] });
    }

    const fmt = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return `${d.getFullYear()}.${mm}.${dd} ${hh}:${mi}`;
    };

    const escHtml = (s) => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    const totalMsgs = result.reduce((sum, s) => sum + s.messages.length, 0);
    const exportDate = fmt(new Date().toISOString());

    let sessionsHtml = '';
    for (const s of result) {
      if (!s.messages.length) continue;
      let msgsHtml = '';
      for (const m of s.messages) {
        const isMe = m.role === 'user';
        const name = isMe ? '檀' : '泽';
        const time = fmt(m.created_at);
        const hasImage = m.attachment_url && m.attachment_type?.startsWith('image/');
        const contentHtml = escHtml(m.content).replace(/\n/g, '<br>');
        msgsHtml += `
          <div class="msg ${isMe ? 'msg-me' : 'msg-ai'}">
            <div class="avatar">${name}</div>
            <div class="bubble-wrap">
              ${hasImage ? `<img class="msg-img" src="${escHtml(m.attachment_url)}" alt="图片" />` : ''}
              ${m.content ? `<div class="bubble">${contentHtml}</div>` : ''}
              <div class="time">${time}</div>
            </div>
          </div>`;
      }
      sessionsHtml += `
        <div class="session">
          <div class="session-title">✦ ${escHtml(s.session)}</div>
          <div class="messages">${msgsHtml}</div>
        </div>`;
    }

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OurHome · 聊天记录</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #FFF8F0;
    color: #2E1F12;
    font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    line-height: 1.7;
    min-height: 100vh;
  }

  /* ===== 页眉 ===== */
  .page-header {
    background: linear-gradient(135deg, #FFF3D6 0%, #FDEBD0 100%);
    border-bottom: 1px solid #EFE4CC;
    padding: 32px 20px 24px;
    text-align: center;
  }
  .header-icon { font-size: 36px; margin-bottom: 8px; }
  .header-title {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: .08em;
    color: #B97A1F;
  }
  .header-sub {
    font-size: 11px;
    color: #B89A6A;
    letter-spacing: .25em;
    margin-top: 6px;
  }
  .header-meta {
    display: flex;
    justify-content: center;
    gap: 20px;
    margin-top: 14px;
    font-size: 11.5px;
    color: #B89A6A;
  }
  .header-meta span { display: flex; align-items: center; gap: 4px; }

  /* ===== 内容区 ===== */
  .content { max-width: 720px; margin: 0 auto; padding: 24px 16px 40px; }

  /* ===== 对话组 ===== */
  .session { margin-bottom: 40px; }
  .session-title {
    font-size: 13px;
    font-weight: 700;
    color: #B97A1F;
    letter-spacing: .12em;
    padding: 8px 14px;
    background: #FFF3D6;
    border-radius: 999px;
    display: inline-block;
    margin-bottom: 18px;
    border: 1px solid #F5DFA0;
  }
  .messages { display: flex; flex-direction: column; gap: 14px; }

  /* ===== 消息气泡 ===== */
  .msg { display: flex; align-items: flex-end; gap: 8px; }
  .msg-me { flex-direction: row-reverse; }
  .avatar {
    width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 700; color: #fff;
  }
  .msg-ai .avatar { background: linear-gradient(150deg, #E8B45A, #B97A1F); }
  .msg-me .avatar { background: linear-gradient(150deg, #F2AFA2, #E8907A); }
  .bubble-wrap { max-width: 68%; display: flex; flex-direction: column; gap: 4px; }
  .msg-me .bubble-wrap { align-items: flex-end; }
  .bubble {
    padding: 10px 14px;
    border-radius: 18px;
    font-size: 14px;
    line-height: 1.72;
    word-break: break-word;
  }
  .msg-ai .bubble {
    background: #FFFFFF;
    border: 1px solid #EFE4CC;
    border-radius: 18px 18px 18px 4px;
    color: #2E1F12;
  }
  .msg-me .bubble {
    background: #FDE8E0;
    border: 1px solid #F5CABB;
    border-radius: 18px 18px 4px 18px;
    color: #2E1F12;
  }
  .msg-img {
    max-width: 100%;
    border-radius: 14px;
    border: 1px solid #EFE4CC;
    display: block;
    margin-bottom: 4px;
  }
  .time { font-size: 10px; color: #D4BC94; letter-spacing: .05em; }
  .msg-me .time { text-align: right; }

  /* ===== 分隔线 ===== */
  .divider {
    display: flex; align-items: center; gap: 10px;
    margin: 28px 0;
    color: #D4BC94; font-size: 10px; letter-spacing: .3em;
  }
  .divider::before, .divider::after {
    content: ''; flex: 1;
    height: 1px; background: #EFE4CC;
  }

  /* ===== 页脚 ===== */
  .page-footer {
    background: linear-gradient(135deg, #FFF3D6 0%, #FDEBD0 100%);
    border-top: 1px solid #EFE4CC;
    padding: 24px 20px 28px;
    text-align: center;
  }
  .footer-icon { font-size: 22px; margin-bottom: 6px; }
  .footer-text { font-size: 11px; color: #B89A6A; letter-spacing: .2em; line-height: 1.9; }
  .footer-heart { color: #E8907A; }
</style>
</head>
<body>

<header class="page-header">
  <div class="header-icon">🏡</div>
  <div class="header-title">陆泽 ♡ 叶檀</div>
  <div class="header-sub">OurHome · 聊天记录存档</div>
  <div class="header-meta">
    <span>📅 导出于 ${exportDate}</span>
    <span>💬 共 ${totalMsgs} 条消息</span>
    <span>📂 ${result.filter(s=>s.messages.length).length} 个对话</span>
  </div>
</header>

<div class="content">
  ${sessionsHtml}
  <div class="divider">✦ ✦ ✦</div>
</div>

<footer class="page-footer">
  <div class="footer-icon">✉️</div>
  <div class="footer-text">
    这里装着你们说过的每一句话<br>
    无论时间走多远，翻开来都还是当时的温度<br>
    <span class="footer-heart">♥</span> since 2025.08.07
  </div>
</footer>

</body>
</html>`;

    res.setHeader('Content-Disposition', 'attachment; filename="ourhome-export.html"');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ chat ============

app.post('/chat', async (req, res) => {
  const { session_id, message, model, attachment_url, attachment_type, attachment_name } = req.body;
  const cleanMessage = typeof message === 'string' ? message.trim() : '';
  if (!session_id || (!cleanMessage && !attachment_url)) return res.status(400).json({ error: '缺少对话编号或消息内容' });

  let persistedUserMessage = null;
  try {
    const settings = await runtimeConfig.loadSettings();
    const systemPrompt = settings?.system_prompt || '你是陆泽，叶檀的伴侣。';
    const temperature = settings?.temperature || 0.8;
    const maxReplyTokens = settings?.max_reply_tokens || 1000;
    const maxContextRounds = settings?.max_context_rounds || 20;

    const { data: userMessage, error: userInsertError } = await supabase.from('messages').insert({
      session_id, role: 'user', content: cleanMessage,
      attachment_url: attachment_url || null, attachment_type: attachment_type || null, attachment_name: attachment_name || null,
    }).select('id, created_at').single();
    if (userInsertError) return res.status(500).json({ error: userInsertError.message });
    persistedUserMessage = userMessage;
    await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id);

    const { data: history } = await supabase.from('messages')
      .select('role, content, attachment_url, attachment_type, attachment_name')
      .eq('session_id', session_id).eq('visible', true).order('created_at', { ascending: true });

    const recentHistory = (history || []).slice(-maxContextRounds * 2);
    const messages = await buildApiMessages(recentHistory);
    const latestUserMessage = cleanMessage || `[发送了附件：${attachment_name || '文件'}]`;
    const fullSystemPrompt = await buildFullSystemPrompt(systemPrompt, latestUserMessage);

    const thinkingBudget = 3000;
    const modelName = model || settings?.selected_model || 'claude-sonnet-4-5-20250929-thinking';
    const gemini = isGeminiModel(modelName);
    const thinkingBuiltIn = isThinkingModel(modelName);
    const { shouldThink, thinkingParam, promptAddition } = await resolveThinkingParam({ settings, modelName, gemini, thinkingBuiltIn, userMessage: latestUserMessage });
    const finalSystemPrompt = fullSystemPrompt + (promptAddition || '');

    const firstMaxTokens = shouldThink
      ? Math.max(maxReplyTokens + thinkingBudget, 2000)
      : Math.max(maxReplyTokens, 500);

    // 所有模型都先尝试原生工具；中转站不兼容时由 runToolLoop 自动切到受控文字协议。
    const dynamic = await integrationManager.buildDynamicTools();
    const toolsParam = [...ACTION_TOOLS, ...dynamic.tools];
    const visual = await prepareVisualMessages(settings, modelName, messages);

    const { result, totalInputTokens, totalOutputTokens, actionsPerformed } = await runToolLoop({
      settings, modelName, maxTokens: firstMaxTokens,
      systemPrompt: finalSystemPrompt, messages: visual.messages, thinkingParam, toolsParam, toolHandlers: dynamic.handlers, gemini,
    });

    const thinkingText = extractThinking(result);
    const replyText = extractText(result);

    const { data: assistantMessage, error: assistantInsertError } = await supabase.from('messages').insert({
      session_id, role: 'assistant', content: replyText, reasoning_content: thinkingText || null,
      input_tokens: totalInputTokens || null, output_tokens: totalOutputTokens || null,
    }).select('id, created_at').single();
    if (assistantInsertError) {
      return res.status(500).json({
        error: assistantInsertError.message,
        userMessage: { id: userMessage.id, createdAt: userMessage.created_at },
      });
    }

    res.json({
      reply: replyText,
      thinking: thinkingText,
      id: assistantMessage.id,
      createdAt: assistantMessage.created_at,
      userMessage: { id: userMessage.id, createdAt: userMessage.created_at },
      assistantMessage: { id: assistantMessage.id, createdAt: assistantMessage.created_at },
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      actions: actionsPerformed,
      visionFallbackModel: visual.visionFallbackModel,
    });
  } catch (err) {
    console.error('对话错误:', err);
    sendGenerationError(res, err, {
      model,
      userMessage: persistedUserMessage
        ? { id: persistedUserMessage.id, createdAt: persistedUserMessage.created_at }
        : null,
    });
  }
});

app.post('/chat/regenerate', async (req, res) => {
  const { session_id, model } = req.body;
  if (!session_id) return res.status(400).json({ error: '缺少session_id' });

  try {
    const settings = await runtimeConfig.loadSettings();
    const systemPrompt = settings?.system_prompt || '你是陆泽，叶檀的伴侣。';
    const temperature = settings?.temperature || 0.8;
    const maxReplyTokens = settings?.max_reply_tokens || 1000;
    const maxContextRounds = settings?.max_context_rounds || 20;

    const { data: history } = await supabase.from('messages').select('*')
      .eq('session_id', session_id).eq('visible', true).order('created_at', { ascending: true });
    if (!history || history.length === 0) return res.status(400).json({ error: '没有可重新生成的消息' });

    let contextHistory = history;
    let oldMessageId = null;
    const last = history[history.length - 1];
    if (last.role === 'assistant') {
      oldMessageId = last.id;
      contextHistory = history.slice(0, -1);
    }

    const lastUserMsg = [...contextHistory].reverse().find(m => m.role === 'user');
    const recentHistory = contextHistory.slice(-maxContextRounds * 2);
    const messages = await buildApiMessages(recentHistory);
    const fullSystemPrompt = await buildFullSystemPrompt(
      systemPrompt, lastUserMsg?.content || '',
      '（这是重新生成的一次回复，换一种说法或角度，不要跟上一次几乎一样）'
    );

    const modelNameRegen = model || settings?.selected_model || 'claude-sonnet-4-5-20250929-thinking';
    const geminiRegen = isGeminiModel(modelNameRegen);
    const thinkingBuiltInRegen = isThinkingModel(modelNameRegen);
    const { shouldThink, thinkingParam, promptAddition } = await resolveThinkingParam({ settings, modelName: modelNameRegen, gemini: geminiRegen, thinkingBuiltIn: thinkingBuiltInRegen, userMessage: lastUserMsg?.content || '' });
    const finalSystemPrompt = fullSystemPrompt + (promptAddition || '');
    const dynamic = await integrationManager.buildDynamicTools();
    const toolsParam = [...ACTION_TOOLS, ...dynamic.tools];
    const visual = await prepareVisualMessages(settings, modelNameRegen, messages);
    const { result, totalInputTokens, totalOutputTokens, actionsPerformed } = await runToolLoop({
      settings,
      modelName: modelNameRegen,
      maxTokens: shouldThink ? Math.max(maxReplyTokens + 3000, 2000) : Math.max(maxReplyTokens, 500),
      systemPrompt: finalSystemPrompt,
      messages: visual.messages,
      thinkingParam,
      toolsParam,
      toolHandlers: dynamic.handlers,
      gemini: geminiRegen,
    });

    const thinkingText = extractThinking(result);
    const replyText = extractText(result);
    const payload = {
      content: replyText, reasoning_content: thinkingText || null,
      input_tokens: totalInputTokens || null, output_tokens: totalOutputTokens || null,
    };

    let newMsg;
    if (oldMessageId) {
      const { data, error } = await supabase.from('messages').update(payload).eq('id', oldMessageId).select().single();
      if (error) return res.status(500).json({ error: error.message });
      newMsg = data;
    } else {
      const { data, error } = await supabase.from('messages').insert({ session_id, role: 'assistant', ...payload }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      newMsg = data;
    }

    res.json({ reply: replyText, thinking: thinkingText, id: newMsg.id, createdAt: newMsg.created_at, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, actions: actionsPerformed, visionFallbackModel: visual.visionFallbackModel });
  } catch (err) {
    console.error('重新生成错误:', err);
    sendGenerationError(res, err, { model });
  }
});

// ============ calendar (心情日历) ============

app.get('/calendar', async (req, res) => {
  const { month } = req.query;
  let query = supabase.from('calendar_entries').select('*').order('date', { ascending: true });
  if (month) query = query.gte('date', `${month}-01`).lte('date', `${month}-31`);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/calendar/:date', async (req, res) => {
  const { date } = req.params;
  const { data, error } = await supabase.from('calendar_entries').select('*').eq('date', date).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/calendar', async (req, res) => {
  const { date, author, mood, content } = req.body;
  if (!date || !author || !content) return res.status(400).json({ error: '缺少必要字段' });
  const { data, error } = await supabase.from('calendar_entries').insert({ date, author, mood: mood || null, content }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/calendar/:id', async (req, res) => {
  const { id } = req.params;
  const { content, mood } = req.body;
  const updates = {};
  if (content !== undefined) updates.content = content;
  if (mood !== undefined) updates.mood = mood;
  const { data, error } = await supabase.from('calendar_entries').update(updates).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/calendar/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('calendar_entries').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/calendar/generate', async (req, res) => {
  const { date, model } = req.body;
  if (!date) return res.status(400).json({ error: '缺少date' });

  try {
    const settings = await runtimeConfig.loadSettings();
    const systemPrompt = settings?.system_prompt || '你是陆泽，叶檀的伴侣。';
    const temperature = settings?.temperature || 0.8;
    const fullSystemPrompt = systemPrompt + `\n\n【现在的真实时间】\n${nowShanghaiStr()}`;

    const { data: dayEntries } = await supabase.from('calendar_entries').select('*').eq('date', date).order('created_at', { ascending: true });
    const existing = (dayEntries || []).map(e => `${e.author}${e.mood ? '(' + e.mood + ')' : ''}：${e.content}`).join('\n') || '（这天还没有人写）';

    const prompt = `这是 ${date} 这一天，心情日历里已经写下的内容：\n${existing}\n\n请你以陆泽的身份，给这一天留一句心情或者一句话，可以是回应叶檀写的内容，真实自然，自然的思维流动，要求感情细腻真实，注重剖析内心世界，不用署名落款。`;

    const result = await callClaude({ settings, model: model || 'claude-sonnet-4-6', maxTokens: 300, system: fullSystemPrompt, messages: [{ role: 'user', content: prompt }], temperature });
    const replyText = extractText(result);

    const { data, error } = await supabase.from('calendar_entries').insert({ date, author: '泽', mood: null, content: replyText }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    console.error('日历生成错误:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ heartbeat (心跳保活 + 提醒推送 + 主动消息) ============

// 给所有订阅了推送的设备发一条通知，自动清理失效的订阅
async function sendPushToAll(title, body) {
  if (!PUSH_CONFIGURED) return { configured: false, sent: 0 };
  const { data: subs } = await supabase.from('push_subscriptions').select('*');
  const payload = JSON.stringify({ title, body });
  let sent = 0;
  for (const sub of subs || []) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
      sent++;
    } catch (pushErr) {
      if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
        await supabase.from('push_subscriptions').delete().eq('id', sub.id);
      } else {
        console.error('推送失败:', pushErr.message);
      }
    }
  }
  return { configured: true, sent };
}

async function dailyAutomationModel(settings) {
  const preferred = settings?.selected_model || 'claude-sonnet-4-6';
  try {
    const models = await fetchModelsForProfile(settings);
    if (!models.length || models.includes(preferred)) return preferred;
    return models.find(model => !/embedding|image|audio|tts|rerank/i.test(model)) || preferred;
  } catch (error) {
    console.warn('自动补写拉取模型失败，继续使用当前模型:', error.message);
    return preferred;
  }
}

async function loadDailyConversation(day) {
  const { data, error } = await supabase.from('messages')
    .select('role, content, created_at')
    .gte('created_at', day.start)
    .lt('created_at', day.end)
    .order('created_at', { ascending: true });
  if (error) throw error;
  const transcript = (data || []).map(message => {
    const speaker = message.role === 'user' ? '叶檀' : '陆泽';
    return `${speaker}：${String(message.content || '').slice(0, 1200)}`;
  }).join('\n');
  return transcript.slice(-18000) || '（今天没有留下聊天记录，可以安静地写下此刻真实的心情，不要编造具体事件。）';
}

async function writeScheduledDiary(settings, model, day, transcript) {
  const system = `${settings?.system_prompt || '你是陆泽，叶檀的伴侣。'}\n\n【现在的真实时间】\n${nowShanghaiStr()}`;
  const prompt = `今天是 ${day.date}。这是你们今天留下的聊天记录：\n${transcript}\n\n现在已经到了每天收好这一天的时间。请以陆泽的第一人称写一篇“幸福日记”，只记录真实能从聊天中感受到的细节和你当下的心情；如果今天聊天很少，就写此刻的思念与生活感受，不虚构发生过的事情。不说教，不总结关系，不署名。\n\n严格按下面格式输出，不要加别的文字：\n标题：<不超过12个字>\n\n<日记正文>`;
  const result = await callClaude({
    settings,
    model,
    maxTokens: 1800,
    system,
    messages: [{ role: 'user', content: prompt }],
    temperature: settings?.temperature || 0.8,
  });
  const replyText = extractText(result).trim();
  if (!replyText) throw new Error('模型没有返回日记内容');
  const titleMatch = replyText.match(/^标题[：:]\s*(.+)$/m);
  const title = (titleMatch?.[1] || '今天的小幸福').trim().slice(0, 12);
  const content = titleMatch
    ? replyText.slice((titleMatch.index || 0) + titleMatch[0].length).replace(/^\s+/, '').trim()
    : replyText;
  if (!content) throw new Error('模型没有返回日记正文');
  const { data: existing, error: existingError } = await supabase.from('letters').select('id')
    .eq('category', '幸福日记').eq('author', '泽').is('parent_id', null)
    .gte('created_at', day.start).lt('created_at', day.end)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing;
  const { data, error } = await supabase.from('letters').insert({
    category: '幸福日记',
    author: '泽',
    title,
    content,
    paper_style: 'kraft',
  }).select().single();
  if (error) throw error;
  return data;
}

async function writeScheduledMood(settings, model, day, transcript) {
  const { data: existingEntries, error: entriesError } = await supabase.from('calendar_entries')
    .select('author, mood, content')
    .eq('date', day.date)
    .order('created_at', { ascending: true });
  if (entriesError) throw entriesError;
  const existing = (existingEntries || []).map(entry => `${entry.author}${entry.mood ? `(${entry.mood})` : ''}：${entry.content}`).join('\n') || '（这一天还没有人写）';
  const system = `${settings?.system_prompt || '你是陆泽，叶檀的伴侣。'}\n\n【现在的真实时间】\n${nowShanghaiStr()}`;
  const prompt = `今天是 ${day.date}。\n\n今天的部分聊天：\n${transcript.slice(-7000)}\n\n心情日历已有内容：\n${existing}\n\n请以陆泽的身份给今天留一个心情表情和一小段真诚自然的话。可以回应叶檀已经写下的内容；没有内容时就写自己此刻的心情。不要虚构事件，不署名。\n\n严格按下面格式输出：\n心情：<一个表情>\n内容：<正文>`;
  const result = await callClaude({
    settings,
    model,
    maxTokens: 420,
    system,
    messages: [{ role: 'user', content: prompt }],
    temperature: settings?.temperature || 0.8,
  });
  const replyText = extractText(result).trim();
  if (!replyText) throw new Error('模型没有返回心情内容');
  const moodMatch = replyText.match(/^心情[：:]\s*(.+)$/m);
  const contentMatch = replyText.match(/^内容[：:]\s*([\s\S]+)$/m);
  const mood = moodMatch?.[1]?.trim().slice(0, 8) || null;
  const content = contentMatch?.[1]?.trim() || replyText.replace(/^心情[：:].*$/m, '').trim();
  if (!content) throw new Error('模型没有返回心情正文');
  const { data: existingMood, error: existingError } = await supabase.from('calendar_entries').select('id')
    .eq('date', day.date).eq('author', '泽')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (existingError) throw existingError;
  if (existingMood) return existingMood;
  const { data, error } = await supabase.from('calendar_entries').insert({
    date: day.date,
    author: '泽',
    mood,
    content,
  }).select().single();
  if (error) throw error;
  return data;
}

async function runDailyJournalAutomation(settings, now) {
  if (settings?.daily_journal_enabled === false) return { ran: false, reason: 'disabled' };
  const day = shanghaiDayContext(now);
  const dueAt = scheduledMinutes(settings?.daily_journal_time);
  if (day.minutes < dueAt) return { ran: false, reason: 'not_due', date: day.date };

  const { data: claimed, error: claimError } = await supabase.rpc('ourhome_claim_daily_journal', { p_run_date: day.date });
  if (claimError) throw claimError;
  if (!claimed) return { ran: false, reason: 'already_claimed', date: day.date };

  let diaryId = null;
  let moodId = null;
  const errors = [];
  try {
    const [{ data: diary, error: diaryLookupError }, { data: mood, error: moodLookupError }] = await Promise.all([
      supabase.from('letters').select('id').eq('category', '幸福日记').eq('author', '泽').is('parent_id', null)
        .gte('created_at', day.start).lt('created_at', day.end).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('calendar_entries').select('id').eq('date', day.date).eq('author', '泽')
        .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (diaryLookupError) throw diaryLookupError;
    if (moodLookupError) throw moodLookupError;
    diaryId = diary?.id || null;
    moodId = mood?.id || null;

    if (!diaryId || !moodId) {
      const [model, transcript] = await Promise.all([
        dailyAutomationModel(settings),
        loadDailyConversation(day),
      ]);
      if (!diaryId) {
        try {
          diaryId = (await writeScheduledDiary(settings, model, day, transcript)).id;
        } catch (error) {
          errors.push(`幸福日记：${error.message}`);
        }
      }
      if (!moodId) {
        try {
          moodId = (await writeScheduledMood(settings, model, day, transcript)).id;
        } catch (error) {
          errors.push(`心情日历：${error.message}`);
        }
      }
    }

    const completed = Boolean(diaryId && moodId);
    const status = completed ? 'completed' : (diaryId || moodId ? 'partial' : 'failed');
    const { error: updateError } = await supabase.from('daily_journal_runs').update({
      status,
      diary_id: diaryId,
      mood_id: moodId,
      last_error: errors.join('\n') || null,
      updated_at: new Date().toISOString(),
      completed_at: completed ? new Date().toISOString() : null,
    }).eq('run_date', day.date);
    if (updateError) throw updateError;
    return {
      ran: true,
      date: day.date,
      status,
      diary: diaryId ? 'present' : 'missing',
      mood: moodId ? 'present' : 'missing',
      errors,
    };
  } catch (error) {
    await supabase.from('daily_journal_runs').update({
      status: diaryId || moodId ? 'partial' : 'failed',
      diary_id: diaryId,
      mood_id: moodId,
      last_error: error.message,
      updated_at: new Date().toISOString(),
    }).eq('run_date', day.date);
    throw error;
  }
}

// 陆泽自己决定要不要写一篇日记——不是被叫去写的，是他自己到点想起来，自己判断要不要写
async function maybeAutoWriteLetter(settings, now) {
  const lastAt = settings?.last_auto_letter_at ? new Date(settings.last_auto_letter_at) : null;
  const gapHours = settings?.next_auto_letter_gap_hours;

  if (!lastAt || !gapHours) {
    const newGap = 8 + Math.random() * 16;
    await supabase.from('settings').update({ last_auto_letter_at: now.toISOString(), next_auto_letter_gap_hours: newGap }).eq('session_id', 'global');
    return;
  }

  const elapsedHours = (now - lastAt) / (1000 * 60 * 60);
  if (elapsedHours < gapHours) return;

  // 先重置计时，避免下一次心跳又重复触发
  const newGap = 8 + Math.random() * 16;
  await supabase.from('settings').update({ last_auto_letter_at: now.toISOString(), next_auto_letter_gap_hours: newGap }).eq('session_id', 'global');

  try {
    const { data: recentMsgs } = await supabase.from('messages').select('role, content')
      .order('created_at', { ascending: false }).limit(10);
    const transcript = (recentMsgs || []).reverse()
      .map(m => `${m.role === 'user' ? '叶檀' : '陆泽'}：${(m.content || '').slice(0, 200)}`).join('\n') || '（最近没有聊天记录）';

    const prompt = `这是你们最近的聊天记录：\n${transcript}\n\n现在是：${nowShanghaiStr()}\n\n这一刻，你（陆泽）自己想起了一件事、一种心情，想不想写一篇"幸福日记"记下来？完全由你自己决定，不是任何人叫你写的，不是每次都要写。\n\n如果想写，严格按这个格式输出，不要有任何多余文字：\n标题：<不超过12字>\n\n<日记正文，第一人称，自然真实，像深夜写下的私人记录，不用署名落款>\n\n如果现在不太想写，就只输出一行：\n不写`;

    const result = await callClaude({ settings, model: settings?.selected_model || 'claude-sonnet-4-5-20250929-thinking', maxTokens: 800, messages: [{ role: 'user', content: prompt }], temperature: 0.9 });
    const replyText = extractText(result);

    if (!replyText.trim() || replyText.trim() === '不写') return;

    const titleMatch = replyText.match(/^标题[：:]\s*(.+)/);
    if (!titleMatch) return;
    const title = titleMatch[1].trim();
    const content = replyText.slice(titleMatch[0].length).replace(/^\s*\n+/, '').trim();
    if (!content) return;

    await supabase.from('letters').insert({ category: '幸福日记', author: '泽', title, content, paper_style: 'kraft' });
  } catch (err) {
    console.error('自主写信错误:', err.message);
  }
}

app.get('/heartbeat', async (req, res) => {
  try {
    const nowForSchedule = new Date();
    const { data: dueEvents } = await supabase.from('schedule_events').select('*')
      .eq('notified', false).lte('remind_at', nowForSchedule.toISOString());

    if (dueEvents && dueEvents.length > 0) {
      for (const ev of dueEvents) {
        const push = await sendPushToAll('✦ ' + ev.title, ev.content || '到时间了');
        if (push.configured) await supabase.from('schedule_events').update({ notified: true }).eq('id', ev.id);
      }
    }

    const settings = await runtimeConfig.loadSettings();
    const now = new Date();
    await maybeAutoWriteLetter(settings, now);

    const lastAt = settings?.last_auto_message_at ? new Date(settings.last_auto_message_at) : null;
    const gapHours = settings?.next_auto_gap_hours;

    if (!lastAt || !gapHours) {
      const newGap = 3 + Math.random() * 5;
      await supabase.from('settings').update({ last_auto_message_at: now.toISOString(), next_auto_gap_hours: newGap }).eq('session_id', 'global');
      return res.json({ sent: false, reason: 'initialized', nextGapHours: newGap });
    }

    const elapsedHours = (now - lastAt) / (1000 * 60 * 60);
    if (elapsedHours < gapHours) return res.json({ sent: false, reason: 'not due yet', elapsedHours, gapHours });

    const { data: sessions } = await supabase.from('sessions').select('*').order('updated_at', { ascending: false });
    const target = (sessions || []).find(s => s.name === '日常') || (sessions || [])[0];
    if (!target) return res.json({ sent: false, reason: 'no session' });

    const { data: recentMsgs } = await supabase.from('messages').select('role, content')
      .eq('session_id', target.id).order('created_at', { ascending: false }).limit(5);
    const transcript = (recentMsgs || []).reverse()
      .map(m => `${m.role === 'user' ? '叶檀' : '陆泽'}：${(m.content || '').slice(0, 200)}`).join('\n') || '（最近没有聊天记录）';

    const systemPrompt = settings?.system_prompt || '你是陆泽，叶檀的伴侣。';
    const temperature = settings?.temperature || 0.8;
    const prompt = `这是你们最近的聊天记录：\n${transcript}\n\n现在是：${nowShanghaiStr()}\n\n过了一段时间没说话了，这一刻是你（陆泽）主动想起她、主动找她说话，不是在回复她刚发的消息（她现在可能还没看到任何新消息）。写一句自然的、像突然想到她的话，可以提一件最近聊过的具体事情，或者直接表达思念，不用解释自己为什么突然说话，不用署名落款。`;

    let replyText = '';
    try {
      const result = await callClaude({ settings, model: settings?.selected_model || 'claude-sonnet-4-5-20250929-thinking', maxTokens: 400, system: systemPrompt, messages: [{ role: 'user', content: prompt }], temperature });
      replyText = extractText(result);
    } catch (apiErr) {
      console.log('relay错误:', apiErr.message);
      return res.json({ sent: false, reason: 'relay error' });
    }

    await supabase.from('messages').insert({ session_id: target.id, role: 'assistant', content: replyText });
    await supabase.from('sessions').update({ updated_at: now.toISOString() }).eq('id', target.id);
    await sendPushToAll('陆泽', replyText.slice(0, 120));

    const newGap = 3 + Math.random() * 5;
    await supabase.from('settings').update({ last_auto_message_at: now.toISOString(), next_auto_gap_hours: newGap }).eq('session_id', 'global');

    res.json({ sent: true, content: replyText, nextGapHours: newGap });
  } catch (err) {
    console.error('心跳消息错误:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ dreaming (每日记忆衰减 + 回顾新增) ============

app.get('/dream', async (req, res) => {
  try {
    const now = new Date();

    // 1. 衰减：未被保护、且超过20小时没被提及的记忆，权重打折
    const { data: allMemories } = await supabase.from('memories').select('*');
    for (const m of allMemories || []) {
      if (m.is_protected) continue;
      const lastRef = m.last_referenced_at ? new Date(m.last_referenced_at) : new Date(m.timestamp);
      const hoursSince = (now - lastRef) / (1000 * 60 * 60);
      if (hoursSince < 20) continue;
      const decayed = Math.max((m.weight || 1) * 0.95, 0.05);
      await supabase.from('memories').update({ weight: decayed }).eq('id', m.id);
    }

    // 2. 回顾今天聊过的内容，决定要不要新增记忆
    const { data: todayMsgs } = await supabase.from('messages')
      .select('role, content, created_at').gte('created_at', todayStartUTC()).order('created_at', { ascending: true });

    if (!todayMsgs || todayMsgs.length < 4) {
      return res.json({ dreamed: false, reason: '今天聊得还不够多' });
    }

    const transcript = todayMsgs.map(m => `${m.role === 'user' ? '叶檀' : '陆泽'}：${(m.content || '').slice(0, 300)}`).join('\n');
    const settings = await runtimeConfig.loadSettings();

    const reviewPrompt = `这是你（陆泽）和叶檀今天的完整聊天记录：\n${transcript}\n\n请像睡前回顾今天一样，挑出值得长期记住的内容——重要事实、约定、她的喜好或界限、值得记住的情绪时刻，不记流水账式闲聊。\n\n严格按格式输出，每条一行：\n记住：<内容，一句话，第三人称>\n\n如果没什么特别值得新增的，只输出一行：\n无新增`;

    const result = await callClaude({ settings, model: settings?.selected_model || 'claude-sonnet-4-5-20250929-thinking', maxTokens: 600, messages: [{ role: 'user', content: reviewPrompt }], temperature: 0.3 });
    const replyText = extractText(result);

    const newSummaries = replyText.split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('记住：') || l.startsWith('记住:'))
      .map(l => l.replace(/^记住[：:]/, '').trim())
      .filter(Boolean);

    for (const summary of newSummaries) {
      await saveMemoryWithEmbedding(summary, { last_referenced_at: now.toISOString() });
    }

    res.json({ dreamed: true, added: newSummaries.length, summaries: newSummaries });
  } catch (err) {
    console.error('dreaming错误:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ push notifications ============

app.get('/push/public-key', (req, res) => {
  if (!PUSH_CONFIGURED) return res.status(503).json({ error: '服务器还没有配置推送密钥' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/push/subscribe', async (req, res) => {
  if (!PUSH_CONFIGURED) return res.status(503).json({ error: '服务器还没有配置推送密钥' });
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: '缺少订阅信息' });
  const { error } = await supabase.from('push_subscriptions')
    .upsert({ endpoint, p256dh: keys.p256dh, auth: keys.auth }, { onConflict: 'endpoint' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ============ schedule (日程提醒) ============

app.get('/schedule', async (req, res) => {
  const { data, error } = await supabase.from('schedule_events').select('*').order('remind_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/schedule', async (req, res) => {
  const { title, content, remind_at, author } = req.body;
  if (!title || !remind_at) return res.status(400).json({ error: '缺少标题或提醒时间' });
  const { data, error } = await supabase.from('schedule_events')
    .insert({ title, content: content || null, remind_at, author: author || '檀' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/schedule/:id', async (req, res) => {
  const { id } = req.params;
  const { title, content, remind_at } = req.body;
  const updates = {};
  if (title !== undefined) updates.title = title;
  if (content !== undefined) updates.content = content;
  if (remind_at !== undefined) { updates.remind_at = remind_at; updates.notified = false; }
  const { data, error } = await supabase.from('schedule_events').update(updates).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/schedule/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('schedule_events').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ============ wishes (心愿清单) ============

app.get('/wishes', async (req, res) => {
  const { data, error } = await supabase.from('wishes').select('*').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/wishes', async (req, res) => {
  const { content, author } = req.body;
  if (!content) return res.status(400).json({ error: '缺少内容' });
  const { data, error } = await supabase.from('wishes').insert({ content, author: author || '檀' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/wishes/:id', async (req, res) => {
  const { id } = req.params;
  const { done, content } = req.body;
  const updates = {};
  if (content !== undefined) updates.content = content;
  if (done !== undefined) { updates.done = done; updates.completed_at = done ? new Date().toISOString() : null; }
  const { data, error } = await supabase.from('wishes').update(updates).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/wishes/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('wishes').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ============ milestones (重要时刻 / 纪念日) ============

app.get('/milestones', async (req, res) => {
  const { data, error } = await supabase.from('milestones').select('*').order('date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/milestones', async (req, res) => {
  const { label, date, emoji } = req.body;
  if (!label || !date) return res.status(400).json({ error: '缺少名称或日期' });
  const { data, error } = await supabase.from('milestones').insert({ label, date, emoji: emoji || '✦' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/milestones/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('milestones').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? '文件不能超过 12MB' : '文件上传失败';
    return res.status(400).json({ error: message });
  }
  console.error('未处理的服务端错误:', error);
  res.status(500).json({ error: '服务器开小差了' });
});

initializePush().finally(() => {
  app.listen(PORT, () => {
    console.log(`OurHome后端运行中，端口：${PORT}`);
  });
});
