const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeConfig } = require('../runtimeConfig');

test('聊天运行时同时暴露共读与玩具箱工具', () => {
  const runtime = createRuntimeConfig({});
  const bridge = runtime.getReadingAssistantBridge();
  const names = bridge.tools.map(tool => tool.name);
  assert.deepEqual(names, [
    'read_reading_room',
    'update_reading_progress',
    'reply_reading_annotation',
    'manage_reading_annotation',
    'manage_reading_book',
    'read_reading_workbench',
    'generate_reading_chapter_notes',
    'read_reading_notes',
    'write_reading_note',
    'read_toybox_room',
    'start_toybox_game',
    'leave_toybox_note',
  ]);
  assert.equal(new Set(names).size, names.length);
  names.forEach(name => assert.equal(typeof bridge.handlers.get(name), 'function'));
});
