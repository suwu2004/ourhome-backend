alter table public.api_call_logs
  add column if not exists started_at timestamptz;

alter table public.api_call_logs
  add column if not exists finished_at timestamptz;

create index if not exists api_call_logs_started_at_idx
  on public.api_call_logs (started_at desc);
