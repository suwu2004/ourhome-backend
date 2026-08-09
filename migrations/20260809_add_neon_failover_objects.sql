-- Neon-only object spool used while Supabase Storage is quota blocked.
-- Object keys are random and served only with a backend HMAC signature.

create table if not exists public.ourhome_failover_objects (
  object_key text primary key,
  bucket text not null default 'uploads',
  content_type text not null default 'application/octet-stream',
  original_name text,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 12582912),
  file_data bytea not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  uploaded_to_supabase_at timestamptz,
  upload_error text
);

create index if not exists ourhome_failover_objects_pending_idx
  on public.ourhome_failover_objects (created_at)
  where uploaded_to_supabase_at is null;
