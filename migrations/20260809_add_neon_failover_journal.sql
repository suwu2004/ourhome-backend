-- Emergency write journal for the Neon disaster-recovery snapshot.
-- Supabase remains authoritative; unapplied rows are replayed after recovery.

create table if not exists public.ourhome_failover_changes (
  id bigserial primary key,
  table_name text not null,
  row_key text not null,
  operation text not null check (operation in ('upsert', 'delete')),
  payload jsonb,
  changed_at timestamptz not null default now(),
  applied_to_supabase_at timestamptz,
  apply_error text
);

create index if not exists ourhome_failover_changes_pending_idx
  on public.ourhome_failover_changes (table_name, row_key, id desc)
  where applied_to_supabase_at is null;
