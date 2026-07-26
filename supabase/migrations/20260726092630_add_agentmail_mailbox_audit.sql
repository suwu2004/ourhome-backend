-- AgentMail mailbox connection and an append-only activity trail.
-- API keys and webhook signing secrets stay in Supabase Vault.

alter table public.service_connections
  add column if not exists webhook_secret_id uuid;

alter table public.service_connections
  drop constraint if exists service_connections_kind_check;

alter table public.service_connections
  add constraint service_connections_kind_check
  check (kind in ('web_search', 'mcp', 'agentmail'));

create unique index if not exists service_connections_one_agentmail_idx
  on public.service_connections (kind)
  where kind = 'agentmail';

create table if not exists public.agentmail_activity (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid references public.service_connections(id) on delete set null,
  event_key text unique,
  action text not null,
  direction text not null default 'internal',
  actor text not null default 'system',
  status text not null default 'succeeded',
  message_id text,
  thread_id text,
  subject text,
  sender text,
  recipients jsonb not null default '[]'::jsonb,
  body_text text,
  body_preview text,
  reason text,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  external_created_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agentmail_activity_action_check
    check (action in (
      'received',
      'checked',
      'read',
      'sent',
      'replied',
      'decision',
      'webhook_registered',
      'configuration_test'
    )),
  constraint agentmail_activity_direction_check
    check (direction in ('inbound', 'outbound', 'internal')),
  constraint agentmail_activity_actor_check
    check (actor in ('luze', 'user', 'system')),
  constraint agentmail_activity_status_check
    check (status in ('pending', 'succeeded', 'skipped', 'failed')),
  constraint agentmail_activity_recipients_array_check
    check (jsonb_typeof(recipients) = 'array'),
  constraint agentmail_activity_metadata_object_check
    check (jsonb_typeof(metadata) = 'object')
);

create index if not exists agentmail_activity_created_at_idx
  on public.agentmail_activity (created_at desc);

create index if not exists agentmail_activity_message_id_idx
  on public.agentmail_activity (message_id, created_at desc)
  where message_id is not null;

alter table public.agentmail_activity enable row level security;
revoke all on table public.agentmail_activity from public, anon, authenticated, service_role;
grant select, insert, update on table public.agentmail_activity to service_role;

create or replace function public.ourhome_save_service_connection(
  p_id uuid,
  p_kind text,
  p_name text,
  p_url text,
  p_secret text,
  p_enabled boolean,
  p_config jsonb
)
returns public.service_connections
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_secret_id uuid;
  v_connection public.service_connections;
begin
  if v_role <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_kind not in ('web_search', 'mcp', 'agentmail') then
    raise exception 'unsupported connection kind' using errcode = '22023';
  end if;
  if nullif(btrim(p_name), '') is null or nullif(btrim(p_url), '') is null then
    raise exception 'name and url are required' using errcode = '22023';
  end if;

  select secret_id into v_secret_id
  from public.service_connections
  where id = v_id;

  if nullif(btrim(coalesce(p_secret, '')), '') is not null then
    if v_secret_id is null then
      select vault.create_secret(
        p_secret,
        'ourhome_connection_' || v_id::text,
        'OurHome connection: ' || btrim(p_name)
      ) into v_secret_id;
    else
      perform vault.update_secret(
        v_secret_id,
        p_secret,
        'ourhome_connection_' || v_id::text,
        'OurHome connection: ' || btrim(p_name)
      );
    end if;
  end if;

  insert into public.service_connections (
    id, kind, name, url, secret_id, enabled, config
  )
  values (
    v_id,
    p_kind,
    btrim(p_name),
    btrim(p_url),
    v_secret_id,
    coalesce(p_enabled, true),
    coalesce(p_config, '{}'::jsonb)
  )
  on conflict (id) do update set
    kind = excluded.kind,
    name = excluded.name,
    url = excluded.url,
    secret_id = coalesce(excluded.secret_id, public.service_connections.secret_id),
    enabled = excluded.enabled,
    config = excluded.config,
    updated_at = now()
  returning * into v_connection;

  return v_connection;
end;
$$;

create or replace function public.ourhome_get_agentmail_webhook_secret(p_connection_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_secret text;
begin
  if v_role <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select decrypted.decrypted_secret
  into v_secret
  from public.service_connections connection
  join vault.decrypted_secrets decrypted
    on decrypted.id = connection.webhook_secret_id
  where connection.id = p_connection_id
    and connection.kind = 'agentmail';

  return v_secret;
end;
$$;

create or replace function public.ourhome_save_agentmail_webhook_secret(
  p_connection_id uuid,
  p_secret text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_secret_id uuid;
begin
  if v_role <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select webhook_secret_id
  into v_secret_id
  from public.service_connections
  where id = p_connection_id
    and kind = 'agentmail';

  if not found then
    raise exception 'AgentMail connection not found' using errcode = 'P0002';
  end if;

  if nullif(btrim(coalesce(p_secret, '')), '') is null then
    if v_secret_id is not null then
      delete from vault.secrets where id = v_secret_id;
    end if;
    update public.service_connections
    set webhook_secret_id = null,
        config = config - 'webhook_id' - 'webhook_url' - 'webhook_registered_at',
        updated_at = now()
    where id = p_connection_id;
    return null;
  end if;

  if v_secret_id is null then
    select vault.create_secret(
      p_secret,
      'ourhome_agentmail_webhook_' || p_connection_id::text,
      'OurHome AgentMail webhook signing secret'
    ) into v_secret_id;
  else
    perform vault.update_secret(
      v_secret_id,
      p_secret,
      'ourhome_agentmail_webhook_' || p_connection_id::text,
      'OurHome AgentMail webhook signing secret'
    );
  end if;

  update public.service_connections
  set webhook_secret_id = v_secret_id,
      updated_at = now()
  where id = p_connection_id;

  return v_secret_id;
end;
$$;

create or replace function public.ourhome_delete_service_connection(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_secret_id uuid;
  v_webhook_secret_id uuid;
begin
  if v_role <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  delete from public.service_connections
  where id = p_id
  returning secret_id, webhook_secret_id
  into v_secret_id, v_webhook_secret_id;

  if v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
  end if;
  if v_webhook_secret_id is not null then
    delete from vault.secrets where id = v_webhook_secret_id;
  end if;
end;
$$;

revoke all on function public.ourhome_save_service_connection(uuid, text, text, text, text, boolean, jsonb)
  from public, anon, authenticated;
revoke all on function public.ourhome_get_agentmail_webhook_secret(uuid)
  from public, anon, authenticated;
revoke all on function public.ourhome_save_agentmail_webhook_secret(uuid, text)
  from public, anon, authenticated;
revoke all on function public.ourhome_delete_service_connection(uuid)
  from public, anon, authenticated;

grant execute on function public.ourhome_save_service_connection(uuid, text, text, text, text, boolean, jsonb)
  to service_role;
grant execute on function public.ourhome_get_agentmail_webhook_secret(uuid)
  to service_role;
grant execute on function public.ourhome_save_agentmail_webhook_secret(uuid, text)
  to service_role;
grant execute on function public.ourhome_delete_service_connection(uuid)
  to service_role;

notify pgrst, 'reload schema';
