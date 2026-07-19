-- Keep the rotated Web Push key pair encrypted and stable across Render restarts.
-- Only the backend's service_role token may call this function.
create or replace function public.ourhome_get_or_create_vapid_keys(p_secret text)
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

  if nullif(btrim(p_secret), '') is null then
    raise exception 'candidate secret is required' using errcode = '22023';
  end if;

  -- Serialize first-boot creation so parallel instances cannot race.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ourhome_vapid_keys', 0)
  );

  select decrypted.decrypted_secret
  into v_secret
  from vault.decrypted_secrets decrypted
  where decrypted.name = 'ourhome_vapid_keys'
  limit 1;

  if v_secret is null then
    perform vault.create_secret(
      p_secret,
      'ourhome_vapid_keys',
      'OurHome generated Web Push VAPID key pair'
    );
    v_secret := p_secret;
  end if;

  return v_secret;
end;
$$;

revoke all on function public.ourhome_get_or_create_vapid_keys(text) from public, anon, authenticated;
grant execute on function public.ourhome_get_or_create_vapid_keys(text) to service_role;
