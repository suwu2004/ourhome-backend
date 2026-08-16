const test = require('node:test');
const assert = require('node:assert/strict');

const { chatLocalToolNeeds, chatNeedsRemoteTools, selectChatTools } = require('../chatToolRouter');

const names = [
  'write_diary', 'save_memory', 'search_memories', 'search_chat_history', 'manage_memory',
  'read_cat_vault', 'record_cat_vault_transaction', 'delete_cat_vault_transaction',
  'read_music_room', 'search_music', 'add_music_track', 'control_music_room',
  'read_reading_room', 'write_reading_note', 'read_toybox_room', 'start_toybox_game',
  'read_drawing_room', 'create_drawing', 'delete_drawing',
  'read_luze_private_room', 'web_search', 'mcp_12345678_weather',
];
const tools = names.map(name => ({ name, description: name, input_schema: { type: 'object', properties: {} } }));
const selectedNames = text => selectChatTools(tools, text).map(tool => tool.name);

test('普通聊天不再携带几十个无关工具定义', () => {
  assert.deepEqual(selectedNames('宝贝抱抱，今天想你了'), []);
});

test('只为明确房间意图开放对应工具组', () => {
  const vault = selectedNames('帮我在猫の金库记一笔，咖啡 28 元');
  assert.ok(vault.includes('record_cat_vault_transaction'));
  assert.ok(vault.includes('read_cat_vault'));
  assert.ok(!vault.includes('read_music_room'));

  const music = selectedNames('去一起听给歌单加一首歌');
  assert.ok(music.includes('add_music_track'));
  assert.ok(!music.includes('record_cat_vault_transaction'));
});

test('明确聊天记录搜索只开放原文搜索，不同时塞入整组记忆工具', () => {
  assert.deepEqual(selectedNames('你不能搜索聊天记录嘛🥺'), ['search_chat_history']);
  assert.deepEqual(selectedNames('搜一下聊天记录，我之前说过喜欢什么'), ['search_chat_history']);
  assert.deepEqual(selectedNames('帮我找一下之前说过的那句话'), ['search_chat_history']);
});

test('普通记忆确认只开放整理后的记忆搜索', () => {
  assert.deepEqual(selectedNames('你记得我以前说过的偏好吗'), ['search_memories']);
  assert.deepEqual(selectedNames('搜一下记忆，之前有没有存过这个'), ['search_memories']);
});

test('明确保存或管理记忆才开放写工具', () => {
  assert.deepEqual(selectedNames('把这个记下来，存进长期记忆'), ['save_memory']);
  assert.deepEqual(selectedNames('把那条长期记忆删掉'), ['manage_memory']);
});

test('共读、玩具熊、画室和私人房间按关键词路由', () => {
  assert.deepEqual(selectedNames('看看共读小屋的批注'), ['read_reading_room', 'write_reading_note']);
  assert.deepEqual(selectedNames('我们开一局五子棋'), ['read_toybox_room', 'start_toybox_game']);
  assert.deepEqual(selectedNames('宝宝给我画一张月亮'), ['read_drawing_room', 'create_drawing', 'delete_drawing']);
  assert.deepEqual(selectedNames('去陆泽的房间看看学习笔记'), ['read_luze_private_room']);
  assert.deepEqual(chatLocalToolNeeds('看看共读小屋的批注'), { reading: true, toybox: false, drawing: false, privateRoom: false });
  assert.deepEqual(chatLocalToolNeeds('我们开一局五子棋'), { reading: false, toybox: true, drawing: false, privateRoom: false });
  assert.deepEqual(chatLocalToolNeeds('宝宝给我画一张月亮'), { reading: false, toybox: false, drawing: true, privateRoom: false });
  assert.deepEqual(chatLocalToolNeeds('宝贝抱抱'), { reading: false, toybox: false, drawing: false, privateRoom: false });
});

test('你画我猜仍只走玩具熊，不误开真正的生图画室', () => {
  assert.deepEqual(selectedNames('我们玩你画我猜'), ['read_toybox_room', 'start_toybox_game']);
});

test('实时信息才开放联网和 MCP 工具', () => {
  assert.deepEqual(selectedNames('查一下今天最新天气'), ['web_search', 'mcp_12345678_weather']);
  assert.ok(!selectedNames('查一下我的聊天记录').includes('web_search'));
  assert.equal(chatNeedsRemoteTools('查一下今天最新天气'), true);
  assert.equal(chatNeedsRemoteTools('查一下我的聊天记录'), false);
});

test('省略式确认会参考最近几条上下文继续开放同一房间工具', () => {
  const selected = selectChatTools(tools, [
    { content: '刚才那笔咖啡记账写错了，需要处理吗？' },
    { content: '删掉吧' },
  ]).map(tool => tool.name);
  assert.ok(selected.includes('delete_cat_vault_transaction'));
});
