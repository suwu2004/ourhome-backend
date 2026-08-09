'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LOCAL_FRONTEND_DIR = path.resolve(__dirname, 'render-frontend-dist');
const DISABLED_LOCAL_FRONTEND_DIR = path.resolve(__dirname, '.render-frontend-disabled');

function indexAssetReferences(html) {
  const source = String(html || '');
  const refs = new Set();
  const pattern = /(?:src|href)=["'](\/assets\/[^"'?#\s>]+)(?:[?#][^"']*)?["']/gi;
  let match;
  while ((match = pattern.exec(source))) refs.add(match[1]);
  return [...refs];
}

function inspectLocalFrontend(rootDir = DEFAULT_LOCAL_FRONTEND_DIR) {
  const root = path.resolve(rootDir);
  const indexPath = path.join(root, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return { present: false, complete: false, rootDir: root, references: [], missing: [] };
  }

  const html = fs.readFileSync(indexPath, 'utf8');
  const references = indexAssetReferences(html);
  const missing = references.filter(reference => {
    const filename = path.resolve(root, reference.slice(1));
    if (!filename.startsWith(`${root}${path.sep}`)) return true;
    return !fs.existsSync(filename);
  });

  return {
    present: true,
    complete: missing.length === 0,
    rootDir: root,
    references,
    missing,
  };
}

function guardRenderFrontend({
  rootDir = process.env.OURHOME_RENDER_FRONTEND_DIR || DEFAULT_LOCAL_FRONTEND_DIR,
  disabledDir = DISABLED_LOCAL_FRONTEND_DIR,
} = {}) {
  const inspection = inspectLocalFrontend(rootDir);
  if (!inspection.present || inspection.complete) return inspection;

  // renderFrontdoorPatch resolves its local root at require-time. Pointing it at
  // an intentionally empty directory makes it use the already-supported remote
  // Vercel fallback instead of serving an index that references missing hashed
  // files. This only affects the optional browser shell; backend/API behavior is
  // untouched.
  process.env.OURHOME_RENDER_FRONTEND_DIR = path.resolve(disabledDir);
  console.warn(
    `[render-frontdoor:integrity] ignoring incomplete local index; missing ${inspection.missing.join(', ')}`,
  );
  return { ...inspection, disabled: true, fallbackDir: process.env.OURHOME_RENDER_FRONTEND_DIR };
}

module.exports = {
  DEFAULT_LOCAL_FRONTEND_DIR,
  DISABLED_LOCAL_FRONTEND_DIR,
  indexAssetReferences,
  inspectLocalFrontend,
  guardRenderFrontend,
};
