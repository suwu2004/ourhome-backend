-- OurHome 主页双人便签与每天缺项补写

create table if not exists public.home_memos (
  id uuid primary key default gen_random_uuid(),
  author text not null,
  content text not null,
  memo_type text not null default 'note',
  remind_on date,
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint home_memos_author_check check (author in ('檀', '泽')),
  constraint home_memos_content_check check (char_length(btrim(content)) between 1 and 300),
  constraint home_memos_type_check check (memo_type in ('note', 'tomorrow'))
);

create index if not exists home_memos_open_updated_idx
  on public.home_memos (completed, updated_at desc);

alter table public.home_memos enable row level security;
revoke all on table public.home_memos from anon, authenticated;
grant select, insert, update, delete on table public.home_memos to service_role;

alter table public.settings
  add column if not exists daily_journal_enabled boolean not null default true,
  add column if not exists daily_journal_time time without time zone not null default time '23:30';

create table if not exists public.daily_journal_runs (
  run_date date primary key,
  status text not null default 'running',
  diary_id uuid references public.letters(id) on delete set null,
  mood_id uuid references public.calendar_entries(id) on delete set null,
  attempt_count integer not null default 1,
  last_error text,
  claimed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint daily_journal_runs_status_check
    check (status in ('running', 'partial', 'completed', 'failed'))
);

create index if not exists daily_journal_runs_diary_id_idx
  on public.daily_journal_runs (diary_id);

create index if not exists daily_journal_runs_mood_id_idx
  on public.daily_journal_runs (mood_id);

alter table public.daily_journal_runs enable row level security;
revoke all on table public.daily_journal_runs from anon, authenticated;
grant select, insert, update, delete on table public.daily_journal_runs to service_role;

create or replace function public.ourhome_claim_daily_journal(p_run_date date)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_claimed boolean := false;
begin
  if v_role <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  insert into public.daily_journal_runs (run_date, status)
  values (p_run_date, 'running')
  on conflict (run_date) do update
  set status = 'running',
      attempt_count = public.daily_journal_runs.attempt_count + 1,
      last_error = null,
      claimed_at = now(),
      updated_at = now(),
      completed_at = null
  where public.daily_journal_runs.status in ('failed', 'partial')
     or (
       public.daily_journal_runs.status = 'running'
       and public.daily_journal_runs.claimed_at < now() - interval '20 minutes'
     )
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

revoke execute on function public.ourhome_claim_daily_journal(date) from public, anon, authenticated;
grant execute on function public.ourhome_claim_daily_journal(date) to service_role;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'ourhome_daily_automation_token') then
    perform vault.create_secret(
      gen_random_uuid()::text || gen_random_uuid()::text,
      'ourhome_daily_automation_token',
      'OurHome Supabase Cron to backend authentication token'
    );
  end if;
end;
$$;

create or replace function public.ourhome_get_daily_automation_token()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_secret text;
begin
  if v_role <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select decrypted_secret
  into v_secret
  from vault.decrypted_secrets
  where name = 'ourhome_daily_automation_token'
  limit 1;

  return v_secret;
end;
$$;

revoke execute on function public.ourhome_get_daily_automation_token() from public, anon, authenticated;
grant execute on function public.ourhome_get_daily_automation_token() to service_role;

create extension if not exists pg_net;
create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

select cron.schedule(
  'ourhome-daily-journal-ping',
  '*/5 * * * *',
  $cron$
    select net.http_post(
      url := 'https://ourhome-backend.onrender.com/automation/daily',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-ourhome-automation', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'ourhome_daily_automation_token'
          limit 1
        )
      ),
      body := jsonb_build_object('triggered_at', now()),
      timeout_milliseconds := 20000
    ) as request_id;
  $cron$
);

notify pgrst, 'reload schema';
