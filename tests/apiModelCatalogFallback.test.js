'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');

test('model-list failures keep a profile saved model usable without a red response', () => {
  assert.match(server, /async function loadModelsForProfile/);
  assert.match(server, /const savedModel = String\(profile\?\.selected_model \|\| ''\)\.trim\(\)/);
  assert.match(server, /models: \[savedModel\]/);
  assert.match(server, /degraded: true/);
  assert.match(server, /res\.json\(await loadModelsForProfile\(settings\)\)/);
  assert.match(server, /res\.json\(await loadModelsForProfile\(profile\)\)/);
});
