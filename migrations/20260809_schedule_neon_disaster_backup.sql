-- Run the database-level disaster snapshot once daily at 20:20 UTC
-- (04:20 Asia/Shanghai). No model/API provider calls are involved.

do $$
declare
  existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname = 'ourhome-neon-disaster-backup' limit 1;
  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;
  perform cron.schedule(
    'ourhome-neon-disaster-backup',
    '20 20 * * *',
    'select public.ourhome_backup_to_neon();'
  );
end $$;
