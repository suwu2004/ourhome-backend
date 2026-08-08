create table if not exists public.luze_private_entries (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('trail','note','idea')),
  title text not null default '',
  body text not null default '',
  keywords text[] not null default '{}',
  stickers text[] not null default '{}',
  source_url text,
  source_title text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists luze_private_entries_kind_created_idx
  on public.luze_private_entries(kind, created_at desc);

alter table public.luze_private_entries enable row level security;

create table if not exists public.luze_learning_settings (
  id text primary key default 'global' check (id = 'global'),
  enabled boolean not null default true,
  synthesis_model text,
  runs_per_day integer not null default 2 check (runs_per_day between 0 and 4),
  max_searches_per_run integer not null default 6 check (max_searches_per_run between 1 and 10),
  last_run_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.luze_learning_settings enable row level security;

insert into public.luze_learning_settings (id)
values ('global')
on conflict (id) do nothing;
