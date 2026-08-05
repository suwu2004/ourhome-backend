const test = require('node:test');
const assert = require('node:assert/strict');
const {
  READING_NOTE_TOOLS,
  normalizeColor,
  createReadingNoteAssistant,
} = require('../readingNotes');

test('共读书签暴露独立读取和写入工具', () => {
  assert.deepEqual(READING_NOTE_TOOLS.map(tool => tool.name), [
    'read_reading_notes',
    'write_reading_note',
  ]);
  const bridge = createReadingNoteAssistant({ supabase: {} }).getToolBridge();
  assert.equal(typeof bridge.handlers.get('read_reading_notes'), 'function');
  assert.equal(typeof bridge.handlers.get('write_reading_note'), 'function');
});

test('旧 rose 颜色会统一成 blush', () => {
  assert.equal(normalizeColor('rose'), 'blush');
  assert.equal(normalizeColor('sky'), 'sky');
  assert.equal(normalizeColor('not-a-color'), 'sky');
});

test('陆泽删除书签必须得到明确确认', async () => {
  const assistant = createReadingNoteAssistant({ supabase: {} });
  const result = await assistant.writeNote({
    action: 'delete',
    note_id: 'note-1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.confirmation_required, true);
  assert.match(result.error, /明确确认/);
});

test('写入工具声明不会修改原文并要求删除确认', () => {
  const tool = READING_NOTE_TOOLS.find(item => item.name === 'write_reading_note');
  assert.match(tool.description, /不会修改书籍原文/);
  assert.ok(tool.input_schema.properties.confirmed);
  assert.deepEqual(tool.input_schema.properties.color.enum, ['honey', 'blush', 'mint', 'sky', 'lavender']);
});
