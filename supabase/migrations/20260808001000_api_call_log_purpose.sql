alter table public.api_call_logs
  add column if not exists purpose text;

create index if not exists api_call_logs_purpose_started_at_idx
  on public.api_call_logs (purpose, started_at desc);
