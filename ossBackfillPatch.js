'use strict';

const { readOssStorageConfig, safeMessage } = require('./ossStorage');
const { migrate } = require('./scripts/migrateSupabaseStorageToOss');

let state = 'not-checked';

function ossBackfillStatus() {
  return state;
}

function startOssBackfillScheduler({
  env = process.env,
  firstDelayMs = 2 * 60 * 1000,
  intervalMs = 12 * 60 * 60 * 1000,
  retryDelayMs = 15 * 60 * 1000,
} = {}) {
  const config = readOssStorageConfig(env);
  if (!config.primary || env.OURHOME_DISABLE_OSS_BACKFILL === '1') {
    state = config.primary ? 'disabled' : 'not-applicable';
    return null;
  }

  const batch = Math.max(1, Math.min(128, Number.parseInt(env.OURHOME_OSS_BACKFILL_BATCH, 10) || 32));
  const concurrency = Math.max(1, Math.min(5, Number.parseInt(env.OURHOME_OSS_BACKFILL_CONCURRENCY, 10) || 2));
  let running = false;
  let retryTimer = null;

  const scheduleRetry = delay => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(run, Math.max(5 * 60 * 1000, delay));
    retryTimer.unref?.();
  };

  const run = async () => {
    if (running) return;
    running = true;
    state = 'running';
    try {
      const summary = await migrate({
        env,
        argv: ['--apply', '--batch', String(batch), '--concurrency', String(concurrency)],
        logger: console,
      });
      state = summary.remainingObjects > 0 ? 'continuing' : 'ready';
      if (summary.remainingObjects > 0) scheduleRetry(5 * 60 * 1000);
    } catch (error) {
      state = 'waiting-source';
      console.warn('[oss-backfill] retained-file migration paused safely:', safeMessage(error));
      scheduleRetry(retryDelayMs);
    } finally {
      running = false;
    }
  };

  state = 'scheduled';
  const first = setTimeout(run, Math.max(0, firstDelayMs));
  first.unref?.();
  const timer = setInterval(run, Math.max(60 * 60 * 1000, intervalMs));
  timer.unref?.();
  return {
    run,
    stop() {
      clearTimeout(first);
      clearTimeout(retryTimer);
      clearInterval(timer);
    },
  };
}

if (!globalThis.__ourhomeOssBackfillScheduler) {
  globalThis.__ourhomeOssBackfillScheduler = startOssBackfillScheduler();
}

module.exports = { startOssBackfillScheduler, ossBackfillStatus };
