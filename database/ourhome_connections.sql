-- OurHome 多 API 档案、联网搜索与远程 MCP 配置
-- 密钥正文存入 Supabase Vault；public 表只保存 Vault secret UUID。

create table if not exists public.api_profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  base_url text not null,
  api_key_secret_id uuid,
  selected_model text,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint api_profiles_name_unique unique (name),
  constraint api_profiles_name_not_blank check (btrim(name) <> ''),
  constraint api_profiles_url_not_blank check (btrim(base_url) <> '')
);

create unique index if not exists api_profiles_one_active_idx
  on public.api_profiles ((is_active)) where is_active;

alter table public.api_profiles enable row level security;
revoke all on table public.api_profiles from anon, authenticated;
grant select, insert, update, delete on table public.api_profiles to service_role;

create table if not exists public.service_connections (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  name text not null,
  url text not null,
  secret_id uuid,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_connections_kind_check check (kind in ('web_search', 'mcp')),
  constraint service_connections_name_not_blank check (btrim(name) <> ''),
  constraint service_connections_url_not_blank check (btrim(url) <> ''),
  constraint service_connections_name_unique unique (kind, name)
);

create unique index if not exists service_connections_one_web_search_idx
  on public.service_connections (kind) where kind = 'web_search';

alter table public.service_connections enable row level security;
revoke all on table public.service_connections from anon, authenticated;
grant select, insert, update, delete on table public.service_connections to service_role;

create or replace function public.ourhome_get_api_profile_secret(p_profile_id uuid)
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
  from public.api_profiles profile
  join vault.decrypted_secrets decrypted on decrypted.id = profile.api_key_secret_id
  where profile.id = p_profile_id;

  return v_secret;
end;
$$;

create or replace function public.ourhome_save_api_profile(
  p_id uuid,
  p_name text,
  p_base_url text,
  p_api_key text,
  p_selected_model text,
  p_make_active boolean
)
returns public.api_profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_secret_id uuid;
  v_make_active boolean := coalesce(p_make_active, false);
  v_profile public.api_profiles;
begin
  if v_role <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if nullif(btrim(p_name), '') is null or nullif(btrim(p_base_url), '') is null then
    raise exception 'name and base_url are required' using errcode = '22023';
  end if;

  select api_key_secret_id into v_secret_id from public.api_profiles where id = v_id;

  if nullif(btrim(coalesce(p_api_key, '')), '') is not null then
    if v_secret_id is null then
      select vault.create_secret(
        p_api_key,
        'ourhome_api_' || v_id::text,
        'OurHome API profile: ' || btrim(p_name)
      ) into v_secret_id;
    else
      perform vault.update_secret(
        v_secret_id,
        p_api_key,
        'ourhome_api_' || v_id::text,
        'OurHome API profile: ' || btrim(p_name)
      );
    end if;
  end if;

  if v_make_active then
    update public.api_profiles set is_active = false, updated_at = now() where is_active;
  end if;

  insert into public.api_profiles (id, name, base_url, api_key_secret_id, selected_model, is_active)
  values (
    v_id,
    btrim(p_name),
    regexp_replace(btrim(p_base_url), '/+$', ''),
    v_secret_id,
    nullif(btrim(coalesce(p_selected_model, '')), ''),
    v_make_active or not exists (select 1 from public.api_profiles where is_active)
  )
  on conflict (id) do update set
    name = excluded.name,
    base_url = excluded.base_url,
    api_key_secret_id = coalesce(excluded.api_key_secret_id, public.api_profiles.api_key_secret_id),
    selected_model = excluded.selected_model,
    is_active = case when v_make_active then true else public.api_profiles.is_active end,
    updated_at = now()
  returning * into v_profile;

  if v_profile.is_active then
    update public.settings
    set api_key = null,
        api_base_url = v_profile.base_url,
        selected_model = coalesce(v_profile.selected_model, selected_model),
        updated_at = now()
    where session_id = 'global';
  end if;

  return v_profile;
end;
$$;

create or replace function public.ourhome_activate_api_profile(p_id uuid)
returns public.api_profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_profile public.api_profiles;
begin
  if v_role <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.api_profiles where id = p_id) then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;

  update public.api_profiles set is_active = false, updated_at = now() where is_active;
  update public.api_profiles set is_active = true, updated_at = now() where id = p_id returning * into v_profile;
  update public.settings
  set api_key = null,
      api_base_url = v_profile.base_url,
      selected_model = coalesce(v_profile.selected_model, selected_model),
      updated_at = now()
  where session_id = 'global';
  return v_profile;
end;
$$;

create or replace function public.ourhome_delete_api_profile(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_secret_id uuid;
  v_was_active boolean;
  v_next public.api_profiles;
begin
  if v_role <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  delete from public.api_profiles where id = p_id returning api_key_secret_id, is_active into v_secret_id, v_was_active;
  if v_secret_id is not null then delete from vault.secrets where id = v_secret_id; end if;

  if coalesce(v_was_active, false) then
    update public.api_profiles
    set is_active = true, updated_at = now()
    where id = (select id from public.api_profiles order by updated_at desc limit 1)
    returning * into v_next;
    if v_next.id is not null then
      update public.settings
      set api_base_url = v_next.base_url,
          selected_model = coalesce(v_next.selected_model, selected_model),
          updated_at = now()
      where session_id = 'global';
    end if;
  end if;
end;
$$;

create or replace function public.ourhome_get_service_secret(p_connection_id uuid)
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
  join vault.decrypted_secrets decrypted on decrypted.id = connection.secret_id
  where connection.id = p_connection_id;
  return v_secret;
end;
$$;

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
  if p_kind not in ('web_search', 'mcp') then
    raise exception 'unsupported connection kind' using errcode = '22023';
  end if;
  if nullif(btrim(p_name), '') is null or nullif(btrim(p_url), '') is null then
    raise exception 'name and url are required' using errcode = '22023';
  end if;

  select secret_id into v_secret_id from public.service_connections where id = v_id;
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

  insert into public.service_connections (id, kind, name, url, secret_id, enabled, config)
  values (v_id, p_kind, btrim(p_name), btrim(p_url), v_secret_id, coalesce(p_enabled, true), coalesce(p_config, '{}'::jsonb))
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

create or replace function public.ourhome_delete_service_connection(p_id uuid)
returns void
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
  delete from public.service_connections where id = p_id returning secret_id into v_secret_id;
  if v_secret_id is not null then delete from vault.secrets where id = v_secret_id; end if;
end;
$$;

revoke all on function public.ourhome_get_api_profile_secret(uuid) from public, anon, authenticated;
revoke all on function public.ourhome_save_api_profile(uuid, text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.ourhome_activate_api_profile(uuid) from public, anon, authenticated;
revoke all on function public.ourhome_delete_api_profile(uuid) from public, anon, authenticated;
revoke all on function public.ourhome_get_service_secret(uuid) from public, anon, authenticated;
revoke all on function public.ourhome_save_service_connection(uuid, text, text, text, text, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.ourhome_delete_service_connection(uuid) from public, anon, authenticated;

grant execute on function public.ourhome_get_api_profile_secret(uuid) to service_role;
grant execute on function public.ourhome_save_api_profile(uuid, text, text, text, text, boolean) to service_role;
grant execute on function public.ourhome_activate_api_profile(uuid) to service_role;
grant execute on function public.ourhome_delete_api_profile(uuid) to service_role;
grant execute on function public.ourhome_get_service_secret(uuid) to service_role;
grant execute on function public.ourhome_save_service_connection(uuid, text, text, text, text, boolean, jsonb) to service_role;
grant execute on function public.ourhome_delete_service_connection(uuid) to service_role;

-- 把旧 settings 单槽位迁移为第一个档案，迁移成功后清空明文密钥。
do $$
declare
  v_settings public.settings;
  v_profile_id uuid := gen_random_uuid();
  v_secret_id uuid;
begin
  if not exists (select 1 from public.api_profiles) then
    select * into v_settings from public.settings where session_id = 'global';
    if v_settings.id is not null and (v_settings.api_key is not null or v_settings.api_base_url is not null) then
      if nullif(btrim(coalesce(v_settings.api_key, '')), '') is not null then
        select vault.create_secret(
          v_settings.api_key,
          'ourhome_api_' || v_profile_id::text,
          'OurHome migrated API profile'
        ) into v_secret_id;
      end if;
      insert into public.api_profiles (id, name, base_url, api_key_secret_id, selected_model, is_active)
      values (
        v_profile_id,
        '原来的站点',
        coalesce(nullif(regexp_replace(btrim(v_settings.api_base_url), '/+$', ''), ''), 'https://api.anthropic.com/v1'),
        v_secret_id,
        v_settings.selected_model,
        true
      );
      update public.settings set api_key = null, updated_at = now() where session_id = 'global';
    end if;
  end if;
end;
$$;

notify pgrst, 'reload schema';
