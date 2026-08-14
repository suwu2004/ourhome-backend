-- pg_cron keeps run history indefinitely. Retain a useful 45-day diagnostic
-- window while preventing system-only job logs from growing without bound.
-- This touches cron metadata only; OurHome messages, memories, letters, photos,
-- API usage records and other user content are outside this cleanup.

do $$
declare
  existing_job bigint;
begin
  select jobid
    into existing_job
    from cron.job
   where jobname = 'ourhome-prune-cron-run-details'
   limit 1;

  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;

  perform cron.schedule(
    'ourhome-prune-cron-run-details',
    '35 21 * * *',
    $cleanup$delete from cron.job_run_details where coalesce(end_time, start_time) < now() - interval '45 days';$cleanup$
  );
end
$$;
