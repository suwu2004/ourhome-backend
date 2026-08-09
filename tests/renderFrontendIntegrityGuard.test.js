'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  indexAssetReferences,
  inspectLocalFrontend,
  guardRenderFrontend,
} = require('../renderFrontendIntegrityGuard');

test('extracts hashed JS and CSS references from the frontend index', () => {
  const html = '<script src="/assets/index-AAA.js"></script><link href="/assets/index-BBB.css?x=1" rel="stylesheet">';
  assert.deepEqual(indexAssetReferences(html), [
    '/assets/index-AAA.js',
    '/assets/index-BBB.css',
  ]);
});

test('accepts a coherent local frontend build', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ourhome-render-integrity-'));
  try {
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'index.html'), '<script src="/assets/app.js"></script><link href="/assets/app.css" rel="stylesheet">');
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log("ok")');
    fs.writeFileSync(path.join(root, 'assets', 'app.css'), 'body{}');
    const result = inspectLocalFrontend(root);
    assert.equal(result.present, true);
    assert.equal(result.complete, true);
    assert.deepEqual(result.missing, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('disables a stale local index whose hashed asset is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ourhome-render-stale-'));
  const disabled = fs.mkdtempSync(path.join(os.tmpdir(), 'ourhome-render-disabled-'));
  const previous = process.env.OURHOME_RENDER_FRONTEND_DIR;
  try {
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'index.html'), '<script src="/assets/app.js"></script><link href="/assets/old.css" rel="stylesheet">');
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log("ok")');

    const result = guardRenderFrontend({ rootDir: root, disabledDir: disabled });
    assert.equal(result.present, true);
    assert.equal(result.complete, false);
    assert.equal(result.disabled, true);
    assert.deepEqual(result.missing, ['/assets/old.css']);
    assert.equal(process.env.OURHOME_RENDER_FRONTEND_DIR, path.resolve(disabled));
  } finally {
    if (previous === undefined) delete process.env.OURHOME_RENDER_FRONTEND_DIR;
    else process.env.OURHOME_RENDER_FRONTEND_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(disabled, { recursive: true, force: true });
  }
});
