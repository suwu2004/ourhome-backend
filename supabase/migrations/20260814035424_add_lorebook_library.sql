create table if not exists public.lorebooks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  enabled boolean not null default true,
  apply_scope text not null default 'theater',
  target_book_id uuid null references public.letters(id) on delete cascade,
  scan_depth integer not null default 12,
  token_budget integer not null default 2000,
  recursive_scanning boolean not null default false,
  source_format text not null default 'ourhome',
  source_name text null,
  raw_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lorebooks_name_length check (char_length(name) between 1 and 120),
  constraint lorebooks_description_length check (char_length(description) <= 2000),
  constraint lorebooks_apply_scope check (apply_scope in ('chat', 'theater', 'both')),
  constraint lorebooks_scan_depth check (scan_depth between 1 and 100),
  constraint lorebooks_token_budget check (token_budget between 128 and 12000)
);

create table if not exists public.lorebook_entries (
  id uuid primary key default gen_random_uuid(),
  lorebook_id uuid not null references public.lorebooks(id) on delete cascade,
  name text not null default '未命名条目',
  comment text not null default '',
  content text not null,
  keys text[] not null default '{}'::text[],
  secondary_keys text[] not null default '{}'::text[],
  selective boolean not null default false,
  constant boolean not null default false,
  use_regex boolean not null default false,
  enabled boolean not null default true,
  insertion_order integer not null default 0,
  priority integer not null default 0,
  position text not null default 'after_character',
  extensions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lorebook_entries_name_length check (char_length(name) between 1 and 120),
  constraint lorebook_entries_comment_length check (char_length(comment) <= 500),
  constraint lorebook_entries_content_length check (char_length(content) between 1 and 40000),
  constraint lorebook_entries_position check (position in ('before_character', 'after_character', 'before_examples', 'after_examples'))
);

create index if not exists lorebooks_active_scope_target_idx
  on public.lorebooks (enabled, apply_scope, target_book_id);
create index if not exists lorebook_entries_book_order_idx
  on public.lorebook_entries (lorebook_id, enabled, priority desc, insertion_order);
create index if not exists lorebook_entries_keys_gin_idx
  on public.lorebook_entries using gin (keys);

alter table public.lorebooks enable row level security;
alter table public.lorebook_entries enable row level security;

revoke all on table public.lorebooks from public, anon, authenticated;
revoke all on table public.lorebook_entries from public, anon, authenticated;
grant select, insert, update, delete on table public.lorebooks to service_role;
grant select, insert, update, delete on table public.lorebook_entries to service_role;

comment on table public.lorebooks is 'OurHome server-only lorebook library with Chat/Theater scope and bounded activation settings.';
comment on table public.lorebook_entries is 'Keyword or constant lore entries preserved in a Character Card compatible shape.';
