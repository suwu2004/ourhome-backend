'use strict';

const GROUPS = Object.freeze({
  diary: ['write_diary', 'read_recent_diary'],
  schedule: ['create_schedule', 'read_schedule', 'manage_schedule'],
  wish: ['add_wish', 'read_wishes', 'manage_wish'],
  whisper: ['write_whisper', 'read_whispers', 'delete_time_letter'],
  mood: ['write_mood_note', 'read_mood_calendar', 'manage_mood_note', 'manage_milestone'],
  favorite: ['read_favorites', 'save_favorite'],
  photo: ['read_photo_memories'],
  vault: ['read_cat_vault', 'record_cat_vault_transaction', 'delete_cat_vault_transaction', 'manage_cat_vault_accounts', 'set_cat_vault_budget', 'manage_cat_vault_goal'],
  memo: ['read_home_memos', 'manage_home_memo'],
  music: ['read_music_room', 'search_music', 'add_music_track', 'control_music_room'],
  agentmail: ['check_agentmail_inbox', 'read_agentmail_message', 'send_agentmail_message', 'reply_agentmail_message', 'read_agentmail_activity'],
});

const INTENTS = Object.freeze([
  ['diary', /幸福日记|写(?:一篇|进)?日记|日记里|记成日记/iu],
  ['schedule', /提醒|日程|闹钟|几点(?:叫|提醒)|到时候|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]/iu],
  ['wish', /心愿|愿望|想一起|以后一起|愿望清单/iu],
  ['whisper', /悄悄话|时光信差|写(?:封|一封)信|回信|信件/iu],
  ['mood', /心情日历|心情记录|里程碑|给今天留(?:一句|个)|某天的心情/iu],
  ['favorite', /收藏|置顶|存起来|回看(?:那句|那条)/iu],
  ['photo', /光影相册|照片记忆|相册|以前的照片|那张照片|记不记得这个/iu],
  ['vault', /猫の金库|金库|记账|账本|余额|账户|预算|支出|收入|花了|赚了|存钱|储蓄目标|流水/iu],
  ['memo', /主页便签|便签|备忘|小纸条|待办/iu],
  ['music', /一起听|歌单|音乐|搜歌|加歌|切歌|下一首|上一首|播放|暂停|随机播放|这首歌/iu],
  ['agentmail', /AgentMail|邮箱|邮件|收件箱|寄信|发邮件|回邮件|来信/iu],
]);

// Raw chat-history lookup is reserved for explicit requests for records/original text.
// A generic “你还记得我以前说过…” uses summarized memory instead, avoiding
// unnecessary history-tool loops unless the user actually asks to search the chat.
const CHAT_HISTORY_RE = /聊天记录|(?:搜(?:索)?|翻|查|找)(?:一下)?(?:聊天|记录)|找(?:一下)?.{0,14}(?:原话|那句话)|之前.{0,12}聊过|原话在哪里/iu;
const MEMORY_LOOKUP_RE = /记得|记忆里|搜(?:索)?(?:一下)?记忆|查(?:一下)?记忆|以前|上次|曾经|长期设定|偏好|界限/iu;
const MEMORY_SAVE_RE = /记住(?:这个|这件事|这条)?|记下来|存进(?:长期)?记忆|保存到(?:长期)?记忆/iu;
const MEMORY_MANAGE_RE = /(?:删|删除|修改|改掉|更新).{0,8}(?:长期)?记忆|记忆.{0,8}(?:删|删除|修改|改掉|更新)/iu;
const READING_RE = /共读|读书|书架|章节|批注|摘抄|书签|阅读进度|预读|哪本书/iu;
const TOYBOX_RE = /玩具熊|玩具箱|工具熊|五子棋|你画我猜|暗号猜猜|默契大考验|游戏记录|开一局/iu;
const DRAWING_CREATE_RE = /画画|画一张|画一下|给我画|帮我画|替我画|生成(?:一张|个)?(?:图|图片|画)|生图|可以画|画吧|去画|开始画/iu;
const DRAWING_DELETE_RE = /(?:删|删除|扔掉|丢掉|不要).{0,12}(?:这|那|刚才|最近)?(?:张)?(?:画|图|图片)|(?:画|图|图片).{0,12}(?:删|删除|扔掉|丢掉)/iu;
const DRAWING_READ_RE = /画室|小画册|刚才.{0,8}画|最近.{0,8}画|画过什么|画过的|看看.{0,8}(?:画|图)/iu;
const DRAWING_RE = /画室|小画册|画画|画一张|画一下|给我画|帮我画|替我画|生成(?:一张|个)?(?:图|图片|画)|生图|可以画|画吧|去画|刚才.{0,8}画|最近.{0,8}画|画过什么|画过的|(?:删|删除|扔掉|丢掉).{0,12}(?:画|图|图片)/iu;
const PRIVATE_ROOM_RE = /陆泽的房间|私人房间|学习笔记|奇思妙想|足迹|敲门/iu;
const WEB_RE = /联网|上网|网上|互联网|全网|最新|新闻|天气|价格|汇率|现在谁|官网|实时|核实(?:一下)?(?:消息|资料|说法|新闻)/iu;
const LOCAL_DATA_RE = /聊天记录|记忆|日记|心情日历|悄悄话|时光信差|收藏|相册|金库|便签|一起听|共读|书架|批注|玩具熊|画室|小画册|陆泽的房间|邮箱|邮件/iu;

function addNames(target, names) {
  for (const name of names || []) target.add(name);
}

function normalizeRoutingText(value) {
  if (!Array.isArray(value)) return String(value || '').trim();
  return value
    .slice(-4)
    .map(item => String(item?.content ?? item ?? '').trim())
    .filter(Boolean)
    .join('\n')
    .slice(-2400);
}

function chatNeedsRemoteTools(routingContext) {
  const text = normalizeRoutingText(routingContext);
  const genericSearch = /搜索(?:一下)?|查(?:一下|查看|找找)|帮我查/iu.test(text);
  return WEB_RE.test(text) || (genericSearch && !LOCAL_DATA_RE.test(text));
}

function chatLocalToolNeeds(routingContext) {
  const text = normalizeRoutingText(routingContext);
  return {
    reading: READING_RE.test(text),
    toybox: TOYBOX_RE.test(text),
    drawing: DRAWING_RE.test(text),
    privateRoom: PRIVATE_ROOM_RE.test(text),
  };
}

function selectChatTools(tools, routingContext) {
  if (!Array.isArray(tools) || !tools.length) return [];
  const text = normalizeRoutingText(routingContext);
  const selected = new Set();

  if (CHAT_HISTORY_RE.test(text)) {
    selected.add('search_chat_history');
  } else if (MEMORY_LOOKUP_RE.test(text)) {
    selected.add('search_memories');
  }
  if (MEMORY_SAVE_RE.test(text)) selected.add('save_memory');
  if (MEMORY_MANAGE_RE.test(text)) selected.add('manage_memory');

  for (const [intent, pattern] of INTENTS) {
    if (pattern.test(text)) addNames(selected, GROUPS[intent]);
  }
  if (READING_RE.test(text)) {
    for (const tool of tools) if (/reading|book|chapter|annotation|bookmark/i.test(tool?.name || '')) selected.add(tool.name);
  }
  if (TOYBOX_RE.test(text)) {
    for (const tool of tools) if (/toybox|gomoku|harmony|secret/i.test(tool?.name || '')) selected.add(tool.name);
  }
  // Paid image generation is intentionally narrower than the room-level intent.
  // Looking at the album never exposes the create tool, and deletion never needs
  // create either. This gives the model one more hard boundary besides its tool
  // description and the user's explicit approval wording.
  if (DRAWING_CREATE_RE.test(text)) selected.add('create_drawing');
  if (DRAWING_DELETE_RE.test(text)) {
    selected.add('read_drawing_room');
    selected.add('delete_drawing');
  }
  if (DRAWING_READ_RE.test(text)) selected.add('read_drawing_room');
  if (PRIVATE_ROOM_RE.test(text)) selected.add('read_luze_private_room');
  if (chatNeedsRemoteTools(text)) {
    for (const tool of tools) {
      const name = String(tool?.name || '');
      if (name === 'web_search' || name.startsWith('mcp_')) selected.add(name);
    }
  }

  return tools.filter(tool => selected.has(tool?.name));
}

// Shared by the chat-history keyword scorer in server.js.  Keep this helper on
// the global object because the scorer lives in the legacy monolithic server
// module and historically referenced textBigrams as a free helper.
function textBigrams(value) {
  const text = String(value || '');
  const result = new Set();
  for (let i = 0; i < text.length - 1; i += 1) {
    result.add(text.slice(i, i + 2));
  }
  return result;
}

globalThis.textBigrams = textBigrams;

module.exports = {
  GROUPS,
  CHAT_HISTORY_RE,
  MEMORY_LOOKUP_RE,
  DRAWING_RE,
  DRAWING_CREATE_RE,
  DRAWING_DELETE_RE,
  DRAWING_READ_RE,
  normalizeRoutingText,
  chatNeedsRemoteTools,
  chatLocalToolNeeds,
  selectChatTools,
  textBigrams,
};
