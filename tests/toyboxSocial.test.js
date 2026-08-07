const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const assistant = fs.readFileSync(path.resolve(__dirname, '..', 'toyboxAssistant.js'), 'utf8');
const routes = fs.readFileSync(path.resolve(__dirname, '..', 'toyboxSocialRoutePatch.js'), 'utf8');
const runtime = fs.readFileSync(path.resolve(__dirname, '..', 'runtimeConfig.js'), 'utf8');
const bootstrap = fs.readFileSync(path.resolve(__dirname, '..', 'runtimeBootstrap.js'), 'utf8');

test('Toybox is exposed to main Chat as local tools', () => {
  assert.match(runtime, /createToyboxAssistant/);
  assert.match(runtime, /toyboxAssistant\.getToolBridge\(\)/);
  assert.match(assistant, /name: 'read_toybox_room'/);
  assert.match(assistant, /name: 'start_toybox_game'/);
  assert.match(assistant, /name: 'leave_toybox_note'/);
});

test('LuZe can proactively initiate but invitation wording discourages spam', () => {
  assert.match(assistant, /不需要等她先下命令/);
  assert.match(assistant, /不要频繁刷邀请/);
  assert.match(assistant, /initiator: 'luze'/);
  assert.match(assistant, /status: 'invited'/);
});

test('shared Toybox history routes are registered', () => {
  assert.match(routes, /\/toybox\/history/);
  assert.match(routes, /\/toybox\/open/);
  assert.match(routes, /\/toybox\/runs\/:id/);
  assert.match(routes, /\/toybox\/runs\/:id\/events/);
  assert.match(bootstrap, /require\('\.\/toyboxSocialRoutePatch'\);/);
  assert.match(bootstrap, /toybox: 'shared-play-v3'/);
});

test('Toybox history supports both participants and completion state', () => {
  assert.match(assistant, /initiator === 'luze'/);
  assert.match(assistant, /completed/);
  assert.match(assistant, /toybox_events/);
});
