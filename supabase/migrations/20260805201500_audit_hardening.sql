-- OurHome production hardening found during the 2026-08-05 audit.

-- Foreign-key indexes keep deletes and joins predictable as shared-reading data grows.
create index if not exists reading_ai_runs_annotation_id_idx
  on public.reading_ai_runs (annotation_id);
create index if not exists reading_ai_runs_book_id_idx
  on public.reading_ai_runs (book_id);
create index if not exists reading_ai_runs_chapter_id_idx
  on public.reading_ai_runs (chapter_id);
create index if not exists phone_calls_summary_message_id_idx
  on public.phone_calls (summary_message_id);

-- The web app never talks to PostgREST directly; all data access goes through the
-- authenticated OurHome backend. Keep browser database roles deny-by-default even
-- if a future table is accidentally created without an RLS policy.
revoke all privileges on all tables in schema public from anon, authenticated;
revoke all privileges on all sequences in schema public from anon, authenticated;

alter default privileges in schema public
  revoke all privileges on tables from anon, authenticated;
alter default privileges in schema public
  revoke all privileges on sequences from anon, authenticated;

-- Preserve the backend service role's explicit access.
grant all privileges on all tables in schema public to service_role;
grant usage, select, update on all sequences in schema public to service_role;

alter default privileges in schema public
  grant all privileges on tables to service_role;
alter default privileges in schema public
  grant usage, select, update on sequences to service_role;
