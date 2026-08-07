create table if not exists public.api_call_logs (
  id uuid primary key default gen_random_uuid(),
  request_id text not null,
  call_index integer not null default 1,
  source text,
  session_id bigint,
  api_profile_id text,
  api_profile_name text,
  api_origin text,
  endpoint text,
  model text not null,
  protocol text,
  status text not null check (status in ('success', 'error')),
  http_status integer,
  input_tokens bigint,
  output_tokens bigint,
  request_chars integer,
  response_chars integer,
  duration_ms integer,
  provider_response_id text,
  error_detail text,
  created_at timestamptz not null default now()
);

create index if not exists api_call_logs_created_at_idx
  on public.api_call_logs (created_at desc);

create index if not exists api_call_logs_request_id_idx
  on public.api_call_logs (request_id);

create index if not exists api_call_logs_model_idx
  on public.api_call_logs (model, created_at desc);
