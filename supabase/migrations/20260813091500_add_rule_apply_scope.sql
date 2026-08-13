alter table public.theater_rules
  add column if not exists apply_scope text not null default 'theater';

alter table public.theater_rules
  drop constraint if exists theater_rules_apply_scope_check;

alter table public.theater_rules
  add constraint theater_rules_apply_scope_check
  check (apply_scope in ('theater', 'chat', 'both'));

comment on column public.theater_rules.apply_scope is
  'Where an enabled rule is injected: theater, chat, or both. Existing rules remain theater-only.';
