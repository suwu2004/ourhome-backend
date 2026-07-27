-- OurHome 记忆日志 M1：大事年表、隐藏标记、每日摘要

create table if not exists public.memory_events (
  id uuid primary key default gen_random_uuid(),
  event_date date not null,
  event_type text not null default 'note',
  title text not null,
  summary text not null,
  source text not null default 'chat',
  topic text,
  tags text[] not null default '{}'::text[],
  emotion text,
  importance integer not null default 3,
  status text not null default 'active',
  occurred_at timestamptz not null default now(),
  related_message_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memory_events_type_check
    check (event_type in ('project', 'life', 'emotion', 'relationship', 'todo', 'memory', 'system', 'note')),
  constraint memory_events_source_check
    check (source in ('chat', 'automation', 'manual', 'agentmail', 'calendar', 'vault')),
  constraint memory_events_status_check
    check (status in ('active', 'continued', 'resolved', 'archived')),
  constraint memory_events_importance_check
    check (importance between 1 and 5),
  constraint memory_events_title_check
    check (char_length(btrim(title)) between 1 and 80),
  constraint memory_events_summary_check
    check (char_length(btrim(summary)) between 1 and 1200)
);

create index if not exists memory_events_date_time_idx
  on public.memory_events (event_date desc, occurred_at desc);

create index if not exists memory_events_status_date_idx
  on public.memory_events (status, event_date desc, occurred_at desc);

create index if not exists memory_events_type_date_idx
  on public.memory_events (event_type, event_date desc);

alter table public.memory_events enable row level security;
revoke all on table public.memory_events from anon, authenticated;
grant select, insert, update, delete on table public.memory_events to service_role;

create table if not exists public.memory_marks (
  id uuid primary key default gen_random_uuid(),
  message_id text,
  session_id text,
  role text not null default 'user',
  mark_date date not null,
  topic text,
  emotion text,
  summary text,
  tags text[] not null default '{}'::text[],
  importance integer not null default 2,
  should_continue boolean not null default false,
  should_remember boolean not null default false,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memory_marks_role_check check (role in ('user', 'assistant', 'system')),
  constraint memory_marks_importance_check check (importance between 1 and 5),
  constraint memory_marks_status_check check (status in ('active', 'continued', 'resolved', 'archived'))
);

create index if not exists memory_marks_date_idx
  on public.memory_marks (mark_date desc, created_at desc);

create index if not exists memory_marks_continue_idx
  on public.memory_marks (should_continue, status, mark_date desc, created_at desc)
  where should_continue = true;

alter table public.memory_marks enable row level security;
revoke all on table public.memory_marks from anon, authenticated;
grant select, insert, update, delete on table public.memory_marks to service_role;

create table if not exists public.daily_summaries (
  summary_date date primary key,
  summary text not null default '',
  highlights text[] not null default '{}'::text[],
  open_threads text[] not null default '{}'::text[],
  mood text,
  event_count integer not null default 0,
  last_message_id text,
  generated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists daily_summaries_updated_idx
  on public.daily_summaries (updated_at desc);

alter table public.daily_summaries enable row level security;
revoke all on table public.daily_summaries from anon, authenticated;
grant select, insert, update, delete on table public.daily_summaries to service_role;

notify pgrst, 'reload schema';
