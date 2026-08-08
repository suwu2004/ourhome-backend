const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'toyboxDrawingPersistencePatch.js'), 'utf8');
const bootstrap = fs.readFileSync(path.resolve(__dirname, '..', 'runtimeBootstrap.js'), 'utf8');
const migration = fs.readFileSync(path.resolve(__dirname, '..', 'migrations', '20260808_allow_gomoku_toybox_runs.sql'), 'utf8');

test('Gomoku is accepted by the Toybox cloud history schema', () => {
  assert.match(migration, /'harmony','drawing','secret','gomoku'/);
});

test('Drawing guesses persist a canvas image and a cloud record', () => {
  assert.match(source, /toybox\/drawings/);
  assert.match(source, /latestActiveDrawing/);
  assert.match(source, /你画我猜 · 自由画/);
  assert.match(source, /record_saved: true/);
});

test('prompted Drawing runs are reused instead of duplicated', () => {
  assert.match(source, /\.eq\('game', 'drawing'\)/);
  assert.match(source, /\.eq\('status', 'active'\)/);
  assert.match(source, /createdFreestyle: false/);
});

test('Drawing persistence is loaded on direct production startup', () => {
  assert.match(bootstrap, /require\('\.\/toyboxDrawingPersistencePatch'\)/);
  assert.match(bootstrap, /toy-bear-cloud-history-v5/);
});
