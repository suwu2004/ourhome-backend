-- Keep Supabase safeupdate enabled while allowing the intentional one-time
-- replacement performed during the phone-local vault import.
create or replace function public.ourhome_vault_replace_state(p_state jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_group jsonb;
  v_account jsonb;
  v_transaction jsonb;
  v_goal jsonb;
  v_group_id uuid;
  v_account_id uuid;
  v_transaction_account_id uuid;
  v_category_id uuid;
  v_account_map jsonb := '{}'::jsonb;
  v_account_name text;
  v_group_name text;
  v_type text;
  v_amount numeric;
  v_month text := to_char(timezone('Asia/Shanghai', now()), 'YYYY-MM');
begin
  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    raise exception '金库数据格式不正确';
  end if;

  delete from public.vault_recurring_items where true;
  delete from public.vault_account_history where true;
  delete from public.vault_transactions where true;
  delete from public.vault_budgets where true;
  delete from public.vault_savings_goals where true;
  delete from public.vault_accounts where true;
  delete from public.vault_account_groups where true;

  for v_group in select value from jsonb_array_elements(coalesce(p_state -> 'accountGroups', '[]'::jsonb))
  loop
    v_group_id := gen_random_uuid();
    insert into public.vault_account_groups (id, name, emoji, sort_order)
    values (
      v_group_id,
      left(coalesce(nullif(btrim(v_group ->> 'name'), ''), '账户'), 80),
      left(coalesce(nullif(v_group ->> 'emoji', ''), '💳'), 16),
      coalesce((v_group ->> 'sortOrder')::integer, 0)
    );

    for v_account in select value from jsonb_array_elements(coalesce(v_group -> 'accounts', '[]'::jsonb))
    loop
      v_account_id := gen_random_uuid();
      v_type := case when v_account ->> 'type' = 'debt' then 'debt' else 'asset' end;
      v_amount := coalesce((v_account ->> 'balance')::numeric, 0);
      insert into public.vault_accounts (id, group_id, name, type, balance, is_debt, emoji, sort_order, updated_at)
      values (
        v_account_id,
        v_group_id,
        left(coalesce(nullif(btrim(v_account ->> 'name'), ''), '账户'), 80),
        v_type,
        v_amount,
        v_type = 'debt',
        left(coalesce(nullif(v_account ->> 'emoji', ''), '💳'), 16),
        coalesce((v_account ->> 'sortOrder')::integer, 0),
        now()
      );
      v_account_map := v_account_map || jsonb_build_object(
        coalesce(nullif(v_account ->> 'id', ''), v_account_id::text),
        v_account_id::text
      );
    end loop;
  end loop;

  for v_transaction in select value from jsonb_array_elements(coalesce(p_state -> 'transactions', '[]'::jsonb))
  loop
    v_transaction_account_id := null;
    if v_account_map ? coalesce(v_transaction ->> 'accountId', '') then
      v_transaction_account_id := (v_account_map ->> (v_transaction ->> 'accountId'))::uuid;
    end if;
    v_type := case when v_transaction ->> 'type' = 'income' then 'income' else 'expense' end;
    v_amount := abs(coalesce((v_transaction ->> 'amount')::numeric, 0));
    select id into v_category_id
    from public.vault_categories
    where type = v_type and name = coalesce(nullif(v_transaction ->> 'category', ''), '其他')
    order by sort_order
    limit 1;
    select account.name, account_group.name
      into v_account_name, v_group_name
    from public.vault_accounts account
    join public.vault_account_groups account_group on account_group.id = account.group_id
    where account.id = v_transaction_account_id;

    if v_amount > 0 then
      insert into public.vault_transactions (
        date, type, amount, category_id, category_name, account_id,
        account_name_snapshot, group_name_snapshot, tag, note, source
      ) values (
        case when coalesce(v_transaction ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
          then (v_transaction ->> 'date')::date else current_date end,
        v_type,
        v_amount,
        v_category_id,
        left(coalesce(nullif(v_transaction ->> 'category', ''), '其他'), 80),
        v_transaction_account_id,
        v_account_name,
        v_group_name,
        left(coalesce(v_transaction ->> 'tag', ''), 40),
        left(coalesce(v_transaction ->> 'note', ''), 500),
        'import'
      );
    end if;
  end loop;

  insert into public.vault_budgets (month, amount)
  values (v_month, greatest(coalesce((p_state ->> 'budget')::numeric, 0), 0))
  on conflict (month) do update set amount = excluded.amount;

  for v_goal in select value from jsonb_array_elements(coalesce(p_state -> 'goals', '[]'::jsonb))
  loop
    if coalesce((v_goal ->> 'target')::numeric, 0) > 0 then
      insert into public.vault_savings_goals (name, emoji, target_amount, current_amount)
      values (
        left(coalesce(nullif(btrim(v_goal ->> 'name'), ''), '存钱目标'), 100),
        left(coalesce(nullif(v_goal ->> 'emoji', ''), '🎯'), 16),
        (v_goal ->> 'target')::numeric,
        greatest(coalesce((v_goal ->> 'current')::numeric, 0), 0)
      );
    end if;
  end loop;

  insert into public.vault_sync_state (id, initialized, imported_at, updated_at)
  values ('global', true, now(), now())
  on conflict (id) do update
    set initialized = true, imported_at = excluded.imported_at, updated_at = excluded.updated_at;

  return jsonb_build_object('ok', true);
end
$$;
