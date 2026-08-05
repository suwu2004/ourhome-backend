const test = require('node:test');
const assert = require('node:assert/strict');
const { READING_ASSISTANT_TOOLS, createReadingAssistant } = require('../readingAssistant');

const expectedTools = [
  'read_reading_room',
  'update_reading_progress',
  'reply_reading_annotation',
  'manage_reading_annotation',
  'manage_reading_book',
  'read_reading_workbench',
  'generate_reading_chapter_notes',
];

test('陆泽拥有完整且不重复的共读工具', () => {
  const names = READING_ASSISTANT_TOOLS.map(tool => tool.name);
  assert.deepEqual(names, expectedTools);
  assert.equal(new Set(names).size, names.length);
});

test('每个共读工具都暴露可执行处理器', () => {
  const assistant = createReadingAssistant({ supabase: {} });
  const bridge = assistant.getToolBridge();
  assert.deepEqual(bridge.tools.map(tool => tool.name), expectedTools);
  expectedTools.forEach(name => assert.equal(typeof bridge.handlers.get(name), 'function'));
});

test('删除型工具明确要求叶檀主动确认', () => {
  const annotationTool = READING_ASSISTANT_TOOLS.find(tool => tool.name === 'manage_reading_annotation');
  const bookTool = READING_ASSISTANT_TOOLS.find(tool => tool.name === 'manage_reading_book');
  assert.match(annotationTool.description, /叶檀明确要求/);
  assert.match(bookTool.description, /叶檀明确要求/);
});

test('批注回复工具说明保存为陆泽蓝色回复', () => {
  const tool = READING_ASSISTANT_TOOLS.find(item => item.name === 'reply_reading_annotation');
  assert.match(tool.description, /陆泽/);
  assert.match(tool.description, /蓝色回复/);
  assert.deepEqual(tool.input_schema.required, ['annotation_id', 'reply']);
});
