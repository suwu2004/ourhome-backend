alter table public.luze_learning_settings
  add column if not exists chat_access_enabled boolean not null default true;

update public.luze_learning_settings
set chat_access_enabled = true
where chat_access_enabled is null;
