-- OurHome 秘密抽屉 / 收藏夹
-- 保存用户或陆泽手动收藏的消息、文本、链接、图片、文件线索。

create table if not exists public.memory_favorites (
  id uuid primary key default gen_random_uuid(),
  favorite_type text not null default 'text',
  title text not null,
  content text,
  source text not null default 'manual',
  source_message_id text,
  source_url text,
  category text not null default '秘密抽屉',
  tags text[] not null default '{}'::text[],
  note text,
  is_pinned boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memory_favorites_type_check check (
    favorite_type in ('message', 'image', 'file', 'text', 'memory', 'event', 'link', 'setting', 'note')
  ),
  constraint memory_favorites_source_check check (
    source in ('chat', 'manual', 'memory', 'event', 'upload', 'system')
  ),
  constraint memory_favorites_title_check check (char_length(btrim(title)) between 1 and 120),
  constraint memory_favorites_content_check check (content is null or char_length(content) <= 4000),
  constraint memory_favorites_note_check check (note is null or char_length(note) <= 800)
);

create index if not exists memory_favorites_pinned_created_idx
  on public.memory_favorites (is_pinned desc, created_at desc);

create index if not exists memory_favorites_category_created_idx
  on public.memory_favorites (category, created_at desc);

alter table public.memory_favorites enable row level security;

revoke all on table public.memory_favorites from anon, authenticated;
grant select, insert, update, delete on table public.memory_favorites to service_role;

notify pgrst, 'reload schema';
