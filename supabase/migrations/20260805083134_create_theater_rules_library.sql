create table if not exists public.theater_rules (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  source_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint theater_rules_title_length check (char_length(btrim(title)) between 1 and 80),
  constraint theater_rules_content_length check (char_length(btrim(content)) between 1 and 20000),
  constraint theater_rules_source_name_length check (source_name is null or char_length(source_name) <= 240),
  constraint theater_rules_sort_order_range check (sort_order between -100000 and 100000)
);

alter table public.theater_rules enable row level security;

revoke all on table public.theater_rules from anon, authenticated;
grant select, insert, update, delete on table public.theater_rules to service_role;

create index if not exists theater_rules_enabled_order_idx
  on public.theater_rules (enabled desc, sort_order asc, created_at asc);

create index if not exists theater_rules_updated_at_idx
  on public.theater_rules (updated_at desc);

do $$
declare
  legacy_content text;
  legacy_rules text;
  legacy_title text;
begin
  if not exists (select 1 from public.theater_rules) then
    select content
      into legacy_content
      from public.letters
      where category = '小剧场通用规则'
        and parent_id is null
      order by created_at desc
      limit 1;

    if legacy_content is not null and btrim(legacy_content) <> '' then
      begin
        legacy_rules := coalesce(legacy_content::jsonb ->> 'rules', legacy_content);
      exception when others then
        legacy_rules := legacy_content;
      end;

      legacy_rules := btrim(legacy_rules);
      if legacy_rules <> '' then
        legacy_title := left(nullif(btrim(split_part(legacy_rules, E'\n', 1)), ''), 80);
        insert into public.theater_rules (title, content, enabled, sort_order, source_name)
        values (coalesce(legacy_title, '原有通用规则'), left(legacy_rules, 20000), true, 0, '从原通用规则迁移');
      end if;
    end if;
  end if;
end
$$;
