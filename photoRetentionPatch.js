'use strict';

const { createClient } = require('@supabase/supabase-js');
const { installPrivateBucketGuard } = require('./privateUploads');
const { startPhotoRetentionScheduler, DEFAULT_RETENTION_DAYS } = require('./photoRetention');
const { getOssStorage } = require('./ossStorage');

if (!globalThis.__ourhomePhotoRetentionScheduler && process.env.OURHOME_DISABLE_PHOTO_RETENTION !== '1') {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (url && key) {
    const bucket = process.env.SUPABASE_UPLOAD_BUCKET || 'uploads';
    const retentionDays = Math.max(1, Number(process.env.CHAT_PHOTO_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS);
    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const rawSupabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Ordinary storage follows the active OSS mode. When OSS is primary, keep a
    // raw source handle so an expired legacy Supabase object must also be removed
    // successfully before its database URL is cleared.
    installPrivateBucketGuard(supabase);
    const sourceStorage = getOssStorage().primary ? rawSupabase.storage.from(bucket) : null;
    globalThis.__ourhomePhotoRetentionScheduler = startPhotoRetentionScheduler({
      supabase,
      sourceStorage,
      retentionDays,
    });
    console.log(`[photo-retention] automatic chat-photo byte cleanup enabled (${retentionDays} days, analysis required)`);
  }
}
