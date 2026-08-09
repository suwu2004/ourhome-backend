-- OurHome disaster recovery: Supabase -> Neon database-level snapshot bridge.
-- The Neon connection string is NOT stored in source control. Production reads
-- it from Supabase Vault secret `ourhome_neon_backup_url`.

create extension if not exists dblink with schema extensions;

create or replace function public.ourhome_backup_to_neon()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, vault, pg_temp
as $$
declare
  neon_url text;
  conn_name text;
  run_token text := md5(clock_timestamp()::text || random()::text);
  table_name text;
  table_payload jsonb;
  table_rows bigint;
  total_rows bigint := 0;
  completed_tables integer := 0;
  backup_tables constant text[] := array[
    'settings','sessions','messages','letters',
    'memories','memory_marks','memory_events','memory_consolidations','memory_favorites','daily_summaries',
    'calendar_entries','milestones','home_memos','wishes','daily_journal_runs',
    'vault_account_groups','vault_accounts','vault_account_history','vault_categories','vault_transactions','vault_budgets','vault_savings_goals','vault_recurring_items','vault_sync_state','vault_husband_phrases',
    'toybox_runs','toybox_events','theater_rules',
    'reading_books','reading_chapters','reading_progress','reading_annotations','reading_notes','reading_chapter_notes','reading_ai_runs',
    'luze_private_entries','luze_learning_settings',
    'intimacy_flow_configs','intimacy_flow_states','intimacy_flow_turn_snapshots',
    'session_context_ledgers','session_summaries'
  ];
  remote_sql text;
  connected boolean := false;
begin
  if not pg_try_advisory_xact_lock(hashtext('ourhome_neon_disaster_backup')) then
    return jsonb_build_object('ok', false, 'skipped', true, 'reason', 'already_running');
  end if;

  select decrypted_secret into neon_url
  from vault.decrypted_secrets
  where name = 'ourhome_neon_backup_url'
  order by created_at desc
  limit 1;

  if coalesce(neon_url, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'backup_secret_missing');
  end if;

  conn_name := 'ourhome_neon_' || left(run_token, 12);
  perform extensions.dblink_connect(conn_name, neon_url);
  connected := true;

  perform extensions.dblink_exec(conn_name, format(
    'insert into public.ourhome_backup_runs(source,status,run_token,note) values (''supabase'',''running'',%L,''database-level snapshot'') on conflict (run_token) do nothing',
    run_token
  ));

  foreach table_name in array backup_tables loop
    if to_regclass(format('public.%I', table_name)) is null then
      continue;
    end if;

    if table_name = 'settings' then
      execute format(
        'select coalesce(jsonb_agg(to_jsonb(q) - ''api_key''), ''[]''::jsonb) from public.%I q',
        table_name
      ) into table_payload;
    else
      execute format(
        'select coalesce(jsonb_agg(to_jsonb(q)), ''[]''::jsonb) from public.%I q',
        table_name
      ) into table_payload;
    end if;

    table_rows := jsonb_array_length(table_payload);

    begin
      perform extensions.dblink_exec(conn_name, 'begin');
      perform extensions.dblink_exec(conn_name, format('delete from public.ourhome_backup_rows where table_name = %L', table_name));

      if table_rows > 0 then
        remote_sql := format($remote$
          insert into public.ourhome_backup_rows(table_name,row_key,payload,source_updated_at,backed_up_at,backup_token)
          select %L,
                 coalesce(item.value->>'id', md5(item.value::text || ':' || item.ordinality::text)),
                 item.value,
                 case
                   when coalesce(item.value->>'updated_at', item.value->>'created_at', '') = '' then null
                   else coalesce(item.value->>'updated_at', item.value->>'created_at')::timestamptz
                 end,
                 now(),
                 %L
          from jsonb_array_elements(%L::jsonb) with ordinality as item(value, ordinality)
        $remote$, table_name, run_token, table_payload::text);
        perform extensions.dblink_exec(conn_name, remote_sql);
      end if;

      perform extensions.dblink_exec(conn_name, format($manifest$
        insert into public.ourhome_backup_manifest(table_name,last_success_at,last_row_count,last_error,updated_at)
        values (%L, now(), %s, null, now())
        on conflict (table_name) do update
          set last_success_at = excluded.last_success_at,
              last_row_count = excluded.last_row_count,
              last_error = null,
              updated_at = now()
      $manifest$, table_name, table_rows));

      perform extensions.dblink_exec(conn_name, 'commit');
      completed_tables := completed_tables + 1;
      total_rows := total_rows + table_rows;
    exception when others then
      begin
        perform extensions.dblink_exec(conn_name, 'rollback');
      exception when others then
        null;
      end;
      begin
        perform extensions.dblink_exec(conn_name, format($error_manifest$
          insert into public.ourhome_backup_manifest(table_name,last_success_at,last_row_count,last_error,updated_at)
          values (%L, null, 0, %L, now())
          on conflict (table_name) do update
            set last_error = excluded.last_error,
                updated_at = now()
        $error_manifest$, table_name, left(sqlerrm, 900)));
        perform extensions.dblink_exec(conn_name, format(
          'update public.ourhome_backup_runs set status=''error'', completed_at=now(), table_count=%s, row_count=%s, note=%L where run_token=%L',
          completed_tables, total_rows, left('failed at ' || table_name || ': ' || sqlerrm, 900), run_token
        ));
      exception when others then
        null;
      end;
      perform extensions.dblink_disconnect(conn_name);
      return jsonb_build_object('ok', false, 'run_token', run_token, 'failed_table', table_name, 'completed_tables', completed_tables, 'rows', total_rows, 'error', sqlerrm);
    end;
  end loop;

  perform extensions.dblink_exec(conn_name, format(
    'update public.ourhome_backup_runs set status=''success'', completed_at=now(), table_count=%s, row_count=%s, note=''complete'' where run_token=%L',
    completed_tables, total_rows, run_token
  ));
  perform extensions.dblink_disconnect(conn_name);

  return jsonb_build_object('ok', true, 'run_token', run_token, 'tables', completed_tables, 'rows', total_rows);
exception when others then
  if connected then
    begin
      perform extensions.dblink_disconnect(conn_name);
    exception when others then
      null;
    end;
  end if;
  return jsonb_build_object('ok', false, 'run_token', run_token, 'tables', completed_tables, 'rows', total_rows, 'error', sqlerrm);
end;
$$;

revoke all on function public.ourhome_backup_to_neon() from public, anon, authenticated;
grant execute on function public.ourhome_backup_to_neon() to service_role;
