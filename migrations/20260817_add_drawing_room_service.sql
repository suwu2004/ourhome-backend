-- Drawing Room keeps its image-generation provider separate from Chat profiles.
-- The provider secret continues to live in Supabase Vault through the existing
-- service_connections helper, while generated image bytes stay in private Storage.

alter table public.service_connections
  drop constraint if exists service_connections_kind_check;

alter table public.service_connections
  add constraint service_connections_kind_check
  check (kind = any (array[
    'web_search'::text,
    'mcp'::text,
    'agentmail'::text,
    'image_generation'::text
  ]));

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
set search_path to ''
as $function$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_secret_id uuid;
  v_connection public.service_connections;
begin
  if v_role <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_kind not in ('web_search', 'mcp', 'agentmail', 'image_generation') then
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
$function$;

create table if not exists public.drawing_history (
  id uuid primary key default gen_random_uuid(),
  prompt text not null check (btrim(prompt) <> ''),
  image_path text not null unique check (btrim(image_path) <> ''),
  provider text,
  model text,
  source text not null default 'drawing-room'
    check (source in ('drawing-room', 'chat')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists drawing_history_created_at_idx
  on public.drawing_history(created_at desc);

alter table public.drawing_history enable row level security;
