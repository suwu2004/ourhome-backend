-- Keep INSERT handling independent from OLD so the trigger is safe on every PostgreSQL path.

create or replace function public.ourhome_prepare_memory_row()
returns trigger
language plpgsql
as $$
begin
  if new.memory_tier is null or new.memory_tier not in ('temporary', 'episodic', 'core', 'archived') then
    new.memory_tier := case when coalesce(new.is_protected, false) then 'core' else 'episodic' end;
  end if;

  if tg_op = 'INSERT' then
    new.memory_kind := public.ourhome_classify_memory_kind(new.summary);
  elsif new.summary is distinct from old.summary
        or new.memory_kind is null
        or new.memory_kind = 'general' then
    new.memory_kind := public.ourhome_classify_memory_kind(new.summary);
  end if;

  new.confidence := greatest(0, least(1, coalesce(new.confidence, 0.750)));
  new.reinforcement_count := greatest(0, coalesce(new.reinforcement_count, 0));
  new.source_type := coalesce(new.source_type, nullif(new.metadata ->> 'source_type', ''), 'chat');

  if coalesce(new.is_protected, false) then
    new.memory_tier := 'core';
  end if;

  if new.memory_tier = 'core' then
    new.is_protected := true;
    new.expires_at := null;
    new.last_confirmed_at := coalesce(new.last_confirmed_at, now());
  elsif new.memory_tier = 'archived' then
    new.is_protected := false;
    new.archived_at := coalesce(new.archived_at, now());
  else
    new.is_protected := false;
    new.archived_at := null;
  end if;

  if tg_op = 'UPDATE'
     and new.last_referenced_at is distinct from old.last_referenced_at
     and new.last_referenced_at is not null then
    new.reinforcement_count := greatest(0, coalesce(old.reinforcement_count, 0)) + 1;
  end if;

  return new;
end;
$$;
