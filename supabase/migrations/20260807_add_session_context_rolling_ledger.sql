create table if not exists public.session_context_ledgers (
  session_id bigint primary key references public.sessions(id) on delete cascade,
  summary text not null default '',
  summarized_through_message_id bigint,
  summarized_message_count integer not null default 0,
  summarized_chars integer not null default 0,
  version integer not null default 0,
  last_attempt_at timestamptz,
  retry_after timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create or replace function public.ourhome_context_ledger_commit(
  p_session_id bigint,
  p_expected_version integer,
  p_summary text,
  p_summarized_through_message_id bigint,
  p_summarized_message_count integer,
  p_summarized_chars integer,
  p_retry_after timestamptz default null,
  p_last_error text default null
)
returns table(
  session_id bigint,
  summary text,
  summarized_through_message_id bigint,
  summarized_message_count integer,
  summarized_chars integer,
  version integer,
  retry_after timestamptz,
  last_error text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.session_context_ledgers%rowtype;
begin
  update public.session_context_ledgers
     set summary = coalesce(p_summary, ''),
         summarized_through_message_id = p_summarized_through_message_id,
         summarized_message_count = greatest(coalesce(p_summarized_message_count, 0), 0),
         summarized_chars = greatest(coalesce(p_summarized_chars, 0), 0),
         retry_after = p_retry_after,
         last_error = nullif(left(coalesce(p_last_error, ''), 800), ''),
         last_attempt_at = now(),
         updated_at = now(),
         version = version + 1
   where session_context_ledgers.session_id = p_session_id
     and session_context_ledgers.version = coalesce(p_expected_version, 0)
  returning * into v_row;

  if found then
    return query select v_row.session_id, v_row.summary, v_row.summarized_through_message_id,
      v_row.summarized_message_count, v_row.summarized_chars, v_row.version,
      v_row.retry_after, v_row.last_error, v_row.updated_at;
    return;
  end if;

  if coalesce(p_expected_version, 0) = 0 then
    begin
      insert into public.session_context_ledgers(
        session_id, summary, summarized_through_message_id, summarized_message_count,
        summarized_chars, version, retry_after, last_error, last_attempt_at, updated_at
      ) values (
        p_session_id, coalesce(p_summary, ''), p_summarized_through_message_id,
        greatest(coalesce(p_summarized_message_count, 0), 0),
        greatest(coalesce(p_summarized_chars, 0), 0), 1,
        p_retry_after, nullif(left(coalesce(p_last_error, ''), 800), ''), now(), now()
      ) returning * into v_row;
      return query select v_row.session_id, v_row.summary, v_row.summarized_through_message_id,
        v_row.summarized_message_count, v_row.summarized_chars, v_row.version,
        v_row.retry_after, v_row.last_error, v_row.updated_at;
      return;
    exception when unique_violation then
      return;
    end;
  end if;
end;
$$;

revoke all on function public.ourhome_context_ledger_commit(bigint, integer, text, bigint, integer, integer, timestamptz, text) from public;
grant execute on function public.ourhome_context_ledger_commit(bigint, integer, text, bigint, integer, integer, timestamptz, text) to service_role;

create index if not exists session_context_ledgers_updated_at_idx
  on public.session_context_ledgers(updated_at desc);
