create table if not exists public.reading_notes (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.reading_books(id) on delete cascade,
  chapter_id uuid references public.reading_chapters(id) on delete cascade,
  chapter_index integer not null default 0 check (chapter_index >= 0),
  author text not null default 'luze' check (author in ('tan', 'luze')),
  kind text not null default 'thought' check (kind in ('thought', 'quote')),
  quote text not null default '' check (char_length(quote) <= 1200),
  content text not null default '' check (char_length(content) <= 8000),
  color text not null default 'sky' check (color in ('honey', 'blush', 'mint', 'sky', 'lavender')),
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(btrim(quote)) > 0 or char_length(btrim(content)) > 0)
);

comment on table public.reading_notes is 'Visible independent notes and excerpts left by Tan or LuZe in the shared reading room.';
create index if not exists reading_notes_book_idx on public.reading_notes(book_id, updated_at desc);
create index if not exists reading_notes_chapter_idx on public.reading_notes(chapter_id, updated_at desc);
create index if not exists reading_notes_pinned_idx on public.reading_notes(book_id, pinned, updated_at desc);

alter table public.reading_notes enable row level security;

revoke all on table public.reading_books from anon, authenticated;
revoke all on table public.reading_chapters from anon, authenticated;
revoke all on table public.reading_progress from anon, authenticated;
revoke all on table public.reading_annotations from anon, authenticated;
revoke all on table public.reading_chapter_notes from anon, authenticated;
revoke all on table public.reading_ai_runs from anon, authenticated;
revoke all on table public.reading_notes from anon, authenticated;

grant all on table public.reading_books to service_role;
grant all on table public.reading_chapters to service_role;
grant all on table public.reading_progress to service_role;
grant all on table public.reading_annotations to service_role;
grant all on table public.reading_chapter_notes to service_role;
grant all on table public.reading_ai_runs to service_role;
grant all on table public.reading_notes to service_role;