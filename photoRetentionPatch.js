'use strict';

const { createClient } = require('@supabase/supabase-js');
const { installPrivateBucketGuard } = require('./privateUploads');
const { startPhotoRetentionScheduler, DEFAULT_RETENTION_DAYS } = require('./photoRetention');

if (!globalThis.__ourhomePhotoRetentionScheduler && process.env.OURHOME_DISABLE_PHOTO_RETENTION !== '1') {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (url && key) {
    const retentionDays = Math.max(1, Number(process.env.CHAT_PHOTO_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS);
    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Use the same private-storage wrapper as ordinary uploads so the optimized
    // bytes replace the optional R2 shadow object as well.
    installPrivateBucketGuard(supabase);
    globalThis.__ourhomePhotoRetentionScheduler = startPhotoRetentionScheduler({ supabase, retentionDays });
    console.log(`[photo-retention] automatic chat-photo compression enabled (${retentionDays} days)`);
  }
}
