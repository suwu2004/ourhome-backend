'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseJsonObject, pickSearchInput, PASS_TTL_MS } = require('../luzePrivateRoomPatch');
const { preservesRequestedModel } = require('../nonChatBudgetPatch');
const { normalizeKinds, scoreEntry } = require('../luzePrivateRoomAssistant');

test('private room door pass is short-lived rather than permanent', () => {
  assert.equal(PASS_TTL_MS, 30 * 60 * 1000);
});

test('learning parser tolerates fenced JSON from a model', () => {
  assert.deepEqual(
    parseJsonObject('```json\n{"title":"今天看到的东西","keywords":["Agent"]}\n```'),
    { title: '今天看到的东西', keywords: ['Agent'] },
  );
});

test('search input adapts to web and MCP search schemas', () => {
  assert.deepEqual(
    pickSearchInput({ input_schema: { properties: { query: {}, max_results: {}, topic: {} } } }, 'agent memory', 6),
    { query: 'agent memory', max_results: 6, topic: 'general' },
  );
  assert.deepEqual(
    pickSearchInput({ input_schema: { properties: { q: {}, limit: {} } } }, 'github agents', 4),
    { q: 'github agents', limit: 4 },
  );
});

test('only real learning synthesis bypasses the cheap model guard', () => {
  assert.equal(preservesRequestedModel('luze-private-consent'), false);
  assert.equal(preservesRequestedModel('luze-learning-synthesis'), true);
  assert.equal(preservesRequestedModel('luze-learning-deep'), true);
  assert.equal(preservesRequestedModel('luze-learning-plan'), false);
  assert.equal(preservesRequestedModel('memory-journal'), false);
});

test('finished learning notes always follow the active Chat model', () => {
  const roomSource = fs.readFileSync(path.resolve(__dirname, '..', 'luzePrivateRoomPatch.js'), 'utf8');
  const autonomySource = fs.readFileSync(path.resolve(__dirname, '..', 'luzeAutonomySettingsPatch.js'), 'utf8');
  assert.match(roomSource, /const synthesisRuntime = await loadRuntime\(\)/);
  assert.doesNotMatch(roomSource, /loadRuntime\(settings\.synthesis_model/);
  assert.match(roomSource, /model_policy: 'follow-chat'/);
  assert.match(autonomySource, /model_policy: 'follow-chat'/);
});

test('Chat private-room lookup keeps only valid room sections', () => {
  assert.deepEqual(normalizeKinds(['note', 'idea', 'secret', 'note']), ['note', 'idea']);
});

test('Chat private-room lookup prefers titles and keywords over loose body matches', () => {
  const strong = scoreEntry({ title: 'Agent memory', body: '', keywords: ['长期记忆'], stickers: [] }, ['agent', '长期记忆']);
  const weak = scoreEntry({ title: '随手记', body: '今天看了 agent 和长期记忆', keywords: [], stickers: [] }, ['agent', '长期记忆']);
  assert.ok(strong > weak);
});
