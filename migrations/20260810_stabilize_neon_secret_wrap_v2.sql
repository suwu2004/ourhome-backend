-- Make encrypted Neon disaster-backup secrets portable between equivalent
-- pooled and direct Neon connection URLs.  The legacy snapshot function is
-- retained intact and wrapped so the daily job keeps all of its existing data
-- coverage before the V2 secret pass replaces only encrypted ciphertext.

create extension if not exists dblink with schema extensions;
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if to_regprocedure('public.ourhome_backup_extended_to_neon_legacy()') is null then
    if to_regprocedure('public.ourhome_backup_extended_to_neon()') is null then
      raise exception 'ourhome_backup_extended_to_neon() must exist before the V2 wrapper is installed';
    end if;
    execute 'alter function public.ourhome_backup_extended_to_neon() rename to ourhome_backup_extended_to_neon_legacy';
  end if;
end;
$$;

create or replace function public.ourhome_neon_secret_wrap_key_v2(p_neon_url text)
returns text
language sql
immutable
strict
set search_path = public, extensions, pg_temp
as $$
  select encode(
    extensions.digest(
      regexp_replace(
        regexp_replace(
          replace(split_part(btrim(p_neon_url), '?', 1), '-pooler.', '.'),
          '^postgres://',
          'postgresql://',
          'i'
        ),
        '/+$',
        ''
      ) || ':ourhome-neon-failover-secrets-v2',
      'sha256'
    ),
    'hex'
  );
$$;

revoke all on function public.ourhome_neon_secret_wrap_key_v2(text) from public, anon, authenticated;

create or replace function public.ourhome_backup_neon_secrets_v2()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, vault, pg_temp
as $$
declare
  neon_url text;
  wrap_key text;
  conn_name text;
  run_token text := md5(clock_timestamp()::text || random()::text);
  secret_payload jsonb;
  secret_rows bigint := 0;
  remote_sql text;
  connected boolean := false;
begin
  select decrypted_secret into neon_url
  from vault.decrypted_secrets
  where name = 'ourhome_neon_backup_url'
  order by created_at desc
  limit 1;

  if coalesce(neon_url, '') = '' then
    return jsonb_build_object('ok', false, 'stage', 'v2_secrets', 'reason', 'backup_secret_missing');
  end if;

  wrap_key := public.ourhome_neon_secret_wrap_key_v2(neon_url);

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
  conn_name := 'ourhome_neon_secret_v2_' || left(run_token, 10);
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
  connected := false;
  return jsonb_build_object(
    'ok', true,
    'stage', 'v2_secrets',
    'encrypted_secrets', secret_rows,
    'wrap_version', 'normalized-v2'
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
    'stage', 'v2_secrets',
    'encrypted_secrets', secret_rows,
    'error', sqlerrm
  );
end;
$$;

revoke all on function public.ourhome_backup_neon_secrets_v2() from public, anon, authenticated;
grant execute on function public.ourhome_backup_neon_secrets_v2() to service_role;

create or replace function public.ourhome_backup_extended_to_neon()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, vault, pg_temp
as $$
declare
  snapshot_result jsonb;
  secret_result jsonb;
begin
  snapshot_result := public.ourhome_backup_extended_to_neon_legacy();
  if not coalesce((snapshot_result->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'stage', 'legacy_snapshot', 'snapshot', snapshot_result);
  end if;

  secret_result := public.ourhome_backup_neon_secrets_v2();
  if not coalesce((secret_result->>'ok')::boolean, false) then
    return jsonb_build_object(
      'ok', false,
      'stage', 'v2_secrets',
      'snapshot', snapshot_result,
      'secrets', secret_result
    );
  end if;

  return snapshot_result || jsonb_build_object(
    'ok', true,
    'secret_wrap', 'normalized-v2',
    'v2_secrets', secret_result
  );
end;
$$;

revoke all on function public.ourhome_backup_extended_to_neon() from public, anon, authenticated;
grant execute on function public.ourhome_backup_extended_to_neon() to service_role;
revoke all on function public.ourhome_backup_extended_to_neon_legacy() from public, anon, authenticated;
grant execute on function public.ourhome_backup_extended_to_neon_legacy() to service_role;

notify pgrst, 'reload schema';
