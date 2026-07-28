alter table public.home_memos
  drop constraint if exists home_memos_content_check;

alter table public.home_memos
  add constraint home_memos_content_check
  check (char_length(btrim(content)) between 1 and 50)
  not valid;
