'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runtimeBootstrap = fs.readFileSync(path.join(__dirname, '..', 'runtimeBootstrap.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

test('Theater history paging loads through the single production startup path', () => {
  assert.equal(packageJson.scripts.start, 'node server.js');
  assert.match(runtimeBootstrap, /require\('\.\/theaterMessagePagingPatch'\)/);
  assert.match(runtimeBootstrap, /theater_message_paging:\s*'supabase-range-v1'/);
});
