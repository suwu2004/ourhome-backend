revoke all privileges on table public.reading_chapter_notes from public, anon, authenticated;
revoke all privileges on table public.reading_ai_runs from public, anon, authenticated;

grant select, insert, update, delete on table public.reading_chapter_notes to service_role;
grant select, insert, update, delete on table public.reading_ai_runs to service_role;
