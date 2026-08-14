'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.resolve(__dirname, '..', 'supabase', 'migrations', '20260814030000_prune_cron_run_details.sql'),
  'utf8',
);

test('cron retention only prunes old system run logs', () => {
  assert.match(migration, /ourhome-prune-cron-run-details/);
  assert.match(migration, /delete from cron\.job_run_details/i);
  assert.match(migration, /interval '45 days'/i);
  assert.doesNotMatch(migration, /delete from public\./i);
});
