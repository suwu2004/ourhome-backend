-- Extend the Neon disaster snapshot with operational data and encrypted runtime
-- credentials. Push subscription endpoints stay in Supabase and are deliberately
-- excluded because they are device-scoped revocable credentials.

create extension if not exists dblink with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create or replace function public.ourhome_backup_extended_to_neon()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, vault, pg_temp
as $$
declare
  base_result jsonb;
  neon_url text;
  wrap_key text;
  conn_name text;
  run_token text := md5(clock_timestamp()::text || random()::text);
  table_name text;
  table_payload jsonb;
  table_rows bigint;
  extra_rows bigint := 0;
  completed_tables integer := 0;
  remote_sql text;
  secret_payload jsonb;
  secret_rows bigint := 0;
  connected boolean := false;
  extra_tables constant text[] := array[
    'api_profiles',
    'service_connections',
    'api_call_logs',
    'agentmail_activity',
    'schedule_events'
  ];
begin
  base_result := public.ourhome_backup_to_neon();
  if not coalesce((base_result->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'stage', 'base_snapshot', 'base', base_result);
  end if;

  select decrypted_secret into neon_url
  from vault.decrypted_secrets
  where name = 'ourhome_neon_backup_url'
  order by created_at desc
  limit 1;

  if coalesce(neon_url, '') = '' then
    return jsonb_build_object('ok', false, 'stage', 'extended_snapshot', 'reason', 'backup_secret_missing');
  end if;
  -- Deriving the wrapping key from the protected Neon connection credential
  -- keeps it out of source control, snapshot rows, and remote SQL statements.
  wrap_key := encode(extensions.digest(neon_url || ':ourhome-neon-failover-secrets-v1', 'sha256'), 'hex');

  conn_name := 'ourhome_neon_extra_' || left(run_token, 10);
  perform extensions.dblink_connect(conn_name, neon_url);
  connected := true;

  perform extensions.dblink_exec(conn_name, 'create extension if not exists pgcrypto');
  perform extensions.dblink_exec(conn_name, $remote$
    create table if not exists public.ourhome_failover_secrets (
      secret_id text primary key,
      secret_name text not null,
      ciphertext bytea not null,
      source_updated_at timestamptz,
      backed_up_at timestamptz not null default now()
    )
  $remote$);
  foreach table_name in array extra_tables loop
    if to_regclass(format('public.%I', table_name)) is null then
      continue;
    end if;

    execute format(
      'select coalesce(jsonb_agg(to_jsonb(q)), ''[]''::jsonb) from public.%I q',
      table_name
    ) into table_payload;
    table_rows := jsonb_array_length(table_payload);

    perform extensions.dblink_exec(conn_name, 'begin');
    begin
      perform extensions.dblink_exec(conn_name, format(
        'delete from public.ourhome_backup_rows where table_name = %L', table_name
      ));
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
          set last_success_at=excluded.last_success_at,
              last_row_count=excluded.last_row_count,
              last_error=null,
              updated_at=now()
      $manifest$, table_name, table_rows));
      perform extensions.dblink_exec(conn_name, 'commit');
    exception when others then
      perform extensions.dblink_exec(conn_name, 'rollback');
      raise;
    end;
    completed_tables := completed_tables + 1;
    extra_rows := extra_rows + table_rows;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'secret_id', id::text,
    'secret_name', name,
    'ciphertext', encode(extensions.pgp_sym_encrypt(decrypted_secret, wrap_key, 'cipher-algo=aes256'), 'base64'),
    'updated_at', updated_at
  )), '[]'::jsonb)
  into secret_payload
  from vault.decrypted_secrets
  where name like 'ourhome_api_%'
     or name like 'ourhome_connection_%'
     or name like 'ourhome_agentmail_webhook_%'
     or name in ('ourhome_daily_automation_token', 'ourhome_vapid_keys');

  secret_rows := jsonb_array_length(secret_payload);
  perform extensions.dblink_exec(conn_name, 'begin');
  begin
    perform extensions.dblink_exec(conn_name, 'delete from public.ourhome_failover_secrets');
    if secret_rows > 0 then
      remote_sql := format($remote$
        insert into public.ourhome_failover_secrets(secret_id,secret_name,ciphertext,source_updated_at,backed_up_at)
        select item.value->>'secret_id',
               item.value->>'secret_name',
               decode(item.value->>'ciphertext', 'base64'),
               nullif(item.value->>'updated_at','')::timestamptz,
               now()
        from jsonb_array_elements(%L::jsonb) item(value)
      $remote$, secret_payload::text);
      perform extensions.dblink_exec(conn_name, remote_sql);
    end if;
    perform extensions.dblink_exec(conn_name, format($manifest$
      insert into public.ourhome_backup_manifest(table_name,last_success_at,last_row_count,last_error,updated_at)
      values ('__encrypted_runtime_secrets', now(), %s, null, now())
      on conflict (table_name) do update
        set last_success_at=excluded.last_success_at,
            last_row_count=excluded.last_row_count,
            last_error=null,
            updated_at=now()
    $manifest$, secret_rows));
    perform extensions.dblink_exec(conn_name, 'commit');
  exception when others then
    perform extensions.dblink_exec(conn_name, 'rollback');
    raise;
  end;

  perform extensions.dblink_disconnect(conn_name);
  return jsonb_build_object(
    'ok', true,
    'base', base_result,
    'extra_tables', completed_tables,
    'extra_rows', extra_rows,
    'encrypted_secrets', secret_rows
  );
exception when others then
  if connected then
    begin
      perform extensions.dblink_disconnect(conn_name);
    exception when others then
      null;
    end;
  end if;
  return jsonb_build_object(
    'ok', false,
    'stage', 'extended_snapshot',
    'extra_tables', completed_tables,
    'extra_rows', extra_rows,
    'encrypted_secrets', secret_rows,
    'error', sqlerrm
  );
end;
$$;

revoke all on function public.ourhome_backup_extended_to_neon() from public, anon, authenticated;
grant execute on function public.ourhome_backup_extended_to_neon() to service_role;

do $$
declare
  existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname = 'ourhome-neon-disaster-backup' limit 1;
  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;
  perform cron.schedule(
    'ourhome-neon-disaster-backup',
    '20 20 * * *',
    'select public.ourhome_backup_extended_to_neon();'
  );
end $$;
