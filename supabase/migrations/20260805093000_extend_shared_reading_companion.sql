alter table public.reading_annotations
  add column if not exists luze_reply text not null default '',
  add column if not exists luze_replied_at timestamptz,
  add column if not exists luze_reply_model text,
  add column if not exists luze_reply_status text not null default 'idle';

create table if not exists public.reading_chapter_notes (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.reading_books(id) on delete cascade,
  chapter_id uuid not null references public.reading_chapters(id) on delete cascade,
  chapter_index integer not null default 0,
  summary text not null default '',
  status text not null default 'pending' check (status in ('pending', 'running', 'ready', 'failed')),
  model text,
  input_tokens integer,
  output_tokens integer,
  duration_ms integer,
  estimated_cost numeric(12,6),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chapter_id)
);

create table if not exists public.reading_ai_runs (
  id uuid primary key default gen_random_uuid(),
  book_id uuid references public.reading_books(id) on delete cascade,
  chapter_id uuid references public.reading_chapters(id) on delete cascade,
  annotation_id uuid references public.reading_annotations(id) on delete set null,
  task text not null check (task in ('chapter_note', 'annotation_reply')),
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  model text,
  input_tokens integer,
  output_tokens integer,
  duration_ms integer,
  estimated_cost numeric(12,6),
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists reading_chapter_notes_book_order_idx on public.reading_chapter_notes(book_id, chapter_index);
create index if not exists reading_chapter_notes_status_idx on public.reading_chapter_notes(status, updated_at desc);
create index if not exists reading_ai_runs_created_idx on public.reading_ai_runs(created_at desc);
create index if not exists reading_annotations_reply_status_idx on public.reading_annotations(luze_reply_status, updated_at desc);

alter table public.reading_chapter_notes enable row level security;
alter table public.reading_ai_runs enable row level security;

grant select, insert, update, delete on public.reading_chapter_notes to service_role;
grant select, insert, update, delete on public.reading_ai_runs to service_role;
