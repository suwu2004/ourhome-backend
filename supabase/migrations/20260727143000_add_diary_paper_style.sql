alter table public.settings
  add column if not exists diary_paper_style text not null default 'floral';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'settings_diary_paper_style_check'
  ) then
    alter table public.settings
      add constraint settings_diary_paper_style_check
      check (diary_paper_style in ('kraft', 'lined', 'floral', 'parchment'))
      not valid;
  end if;
end $$;

alter table public.settings
  validate constraint settings_diary_paper_style_check;
