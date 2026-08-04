-- OurHome 动态回复篇幅：陆泽的全局最低回复长度

alter table public.settings
  add column if not exists min_reply_chars integer not null default 80;

alter table public.settings
  drop constraint if exists settings_min_reply_chars_check;

alter table public.settings
  add constraint settings_min_reply_chars_check
  check (min_reply_chars between 0 and 1200);
