-- Neon-only encrypted journal for credentials created or changed while the
-- Supabase data plane is quota-blocked. The normal snapshot job never replaces
-- this table, so a later backup cannot silently resurrect an older key.

create extension if not exists pgcrypto;

create table if not exists public.ourhome_failover_secret_changes (
  secret_id text primary key,
  secret_name text not null,
  operation text not null check (operation in ('upsert', 'delete')),
  ciphertext bytea,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  applied_to_supabase_at timestamptz,
  constraint ourhome_failover_secret_change_payload check (
    (operation = 'upsert' and ciphertext is not null)
    or (operation = 'delete' and ciphertext is null)
  )
);

create index if not exists ourhome_failover_secret_changes_pending_idx
  on public.ourhome_failover_secret_changes(updated_at)
  where applied_to_supabase_at is null;

revoke all on table public.ourhome_failover_secret_changes from public;
