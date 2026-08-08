'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isLuzeRoomKnockRequest,
  localLuzeRoomKnockResponse,
} = require('../luzeDoorCostGuardPatch');

const bootstrap = fs.readFileSync(path.resolve(__dirname, '..', 'runtimeBootstrap.js'), 'utf8');

test('Luze private-room knock is intercepted locally before the private-room module loads', () => {
  const guardIndex = bootstrap.indexOf("require('./luzeDoorCostGuardPatch');");
  const roomIndex = bootstrap.indexOf("require('./luzePrivateRoomPatch');");
  assert.ok(guardIndex >= 0);
  assert.ok(roomIndex > guardIndex);
  assert.match(bootstrap, /luze_room_knock: 'local-zero-api-v1'/);
});

test('only the old room-consent provider purpose is intercepted', () => {
  assert.equal(isLuzeRoomKnockRequest({ headers: { 'X-OurHome-Call-Purpose': 'luze-private-consent' } }), true);
  assert.equal(isLuzeRoomKnockRequest({ headers: { 'X-OurHome-Call-Purpose': 'luze-learning-plan' } }), false);
  assert.equal(isLuzeRoomKnockRequest({ headers: {} }), false);
});

test('local room knock always grants the short-lived door flow with zero model usage', async () => {
  const response = localLuzeRoomKnockResponse();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-OurHome-Local-Response'), 'luze-room-knock');
  const payload = await response.json();
  assert.equal(payload.model, 'ourhome-local-room-knock');
  assert.deepEqual(payload.usage, { input_tokens: 0, output_tokens: 0 });
  const decision = JSON.parse(payload.content[0].text);
  assert.equal(decision.allow, true);
  assert.match(decision.message, /进来|门/);
});
