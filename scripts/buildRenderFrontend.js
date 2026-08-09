'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, '.render-frontend-src');
const OUTPUT_DIR = path.join(ROOT, '.render-frontend-dist');
const FRONTEND_REPO = 'https://github.com/suwu2004/ourhome-frontend.git';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: process.env,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? String(result.stderr || result.stdout || '').trim() : '';
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})${detail ? `: ${detail}` : ''}`);
  }
  return options.capture ? String(result.stdout || '').trim() : '';
}

function clean(pathname) {
  fs.rmSync(pathname, { recursive: true, force: true });
}

function buildRenderFrontend() {
  clean(SOURCE_DIR);
  clean(OUTPUT_DIR);

  console.log('[render-frontdoor:build] cloning OurHome frontend');
  run('git', ['clone', '--depth', '1', '--branch', 'main', FRONTEND_REPO, SOURCE_DIR]);

  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: SOURCE_DIR, capture: true });
  console.log(`[render-frontdoor:build] frontend commit ${commit}`);

  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: SOURCE_DIR });
  run('npm', ['run', 'build'], { cwd: SOURCE_DIR });

  const builtDir = path.join(SOURCE_DIR, 'dist');
  if (!fs.existsSync(path.join(builtDir, 'index.html'))) {
    throw new Error('frontend build completed without dist/index.html');
  }

  fs.cpSync(builtDir, OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, '.ourhome-build.json'), JSON.stringify({
    source: 'suwu2004/ourhome-frontend',
    commit,
    built_at: new Date().toISOString(),
  }, null, 2));
  console.log('[render-frontdoor:build] local frontend copy ready');
}

try {
  buildRenderFrontend();
} catch (error) {
  // The fallback front door must never make the primary backend undeployable.
  // Runtime can still use the older Vercel fetch path if this optional build fails.
  console.warn('[render-frontdoor:build] optional local frontend build failed:', error?.message || error);
  clean(OUTPUT_DIR);
} finally {
  clean(SOURCE_DIR);
}

module.exports = { buildRenderFrontend };
