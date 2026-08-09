-- Persist the formerly device-only mood-calendar day colors so reinstalling or
-- moving between the phone and tablet keeps the same hand-painted calendar.

alter table public.settings
  add column if not exists calendar_day_colors jsonb not null default '{}'::jsonb;

update public.settings
set calendar_day_colors = '{}'::jsonb
where calendar_day_colors is null;
