'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');

test('manual Happiness Diary ignores a stale client model and follows active Chat settings', () => {
  assert.match(server, /const isHappinessDiary = category === '幸福日记'/);
  assert.match(server, /isHappinessDiary\s*\? \(settings\?\.selected_model \|\| 'claude-sonnet-4-6'\)/);
  assert.match(server, /purpose: isHappinessDiary \? 'happiness-diary' : undefined/);
});

test('scheduled diary keeps Chat model exact while mood remains separately budgeted', () => {
  assert.match(server, /async function dailyAutomationModel\(settings\)[\s\S]*return settings\?\.selected_model \|\| 'claude-sonnet-4-6';/);
  assert.match(server, /async function writeScheduledDiary[\s\S]*purpose: 'happiness-diary'/);
  assert.match(server, /async function writeScheduledMood[\s\S]*purpose: 'daily-mood'/);
});

test('provider calls can carry an explicit purpose through every cost and audit guard', () => {
  assert.match(server, /async function callClaude\(\{[^}]*purpose[^}]*\}\)/);
  assert.match(server, /headers\['X-OurHome-Call-Purpose'\] = String\(purpose\)/);
});
