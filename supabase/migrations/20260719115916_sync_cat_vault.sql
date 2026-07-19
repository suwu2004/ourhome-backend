create table if not exists public.vault_account_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  emoji text not null default '💳',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vault_sync_state (
  id text primary key default 'global' check (id = 'global'),
  initialized boolean not null default false,
  imported_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.vault_account_groups enable row level security;
alter table public.vault_sync_state enable row level security;

alter table public.vault_accounts
  add column if not exists group_id uuid,
  add column if not exists emoji text not null default '💳';

alter table public.vault_transactions
  add column if not exists category_name text not null default '其他',
  add column if not exists account_name_snapshot text,
  add column if not exists group_name_snapshot text;

do $$
declare
  v_group_id uuid;
begin
  if exists (
    select 1 from public.vault_accounts
    where group_id is null and (name ~ '微信|零钱通|钱包' or type like 'wechat%')
  ) then
    select id into v_group_id from public.vault_account_groups where name = '微信' order by created_at limit 1;
    if v_group_id is null then
      insert into public.vault_account_groups (name, emoji, sort_order)
      values ('微信', '💚', 1)
      returning id into v_group_id;
    end if;
    update public.vault_accounts
      set group_id = v_group_id,
          emoji = case when name ~ '零钱通' then '🍃' else '👛' end
      where group_id is null and (name ~ '微信|零钱通|钱包' or type like 'wechat%');
  end if;

  v_group_id := null;
  if exists (
    select 1 from public.vault_accounts
    where group_id is null and (name ~ '支付宝|余额宝|花呗' or type in ('alipay', 'yuebao', 'debt'))
  ) then
    select id into v_group_id from public.vault_account_groups where name = '支付宝' order by created_at limit 1;
    if v_group_id is null then
      insert into public.vault_account_groups (name, emoji, sort_order)
      values ('支付宝', '🟦', 2)
      returning id into v_group_id;
    end if;
    update public.vault_accounts
      set group_id = v_group_id,
          emoji = case when is_debt or name ~ '花呗' then '🌸' else '💰' end
      where group_id is null and (name ~ '支付宝|余额宝|花呗' or type in ('alipay', 'yuebao', 'debt'));
  end if;

  v_group_id := null;
  if exists (
    select 1 from public.vault_accounts
    where group_id is null and (name ~ '银行卡|工资卡|储蓄卡|信用卡|银行' or type = 'bank')
  ) then
    select id into v_group_id from public.vault_account_groups where name = '银行卡' order by created_at limit 1;
    if v_group_id is null then
      insert into public.vault_account_groups (name, emoji, sort_order)
      values ('银行卡', '💳', 3)
      returning id into v_group_id;
    end if;
    update public.vault_accounts
      set group_id = v_group_id, emoji = '💳'
      where group_id is null and (name ~ '银行卡|工资卡|储蓄卡|信用卡|银行' or type = 'bank');
  end if;

  v_group_id := null;
  if exists (select 1 from public.vault_accounts where group_id is null) then
    select id into v_group_id from public.vault_account_groups where name = '其他账户' order by created_at limit 1;
    if v_group_id is null then
      insert into public.vault_account_groups (name, emoji, sort_order)
      values ('其他账户', '🧺', 99)
      returning id into v_group_id;
    end if;
    update public.vault_accounts set group_id = v_group_id where group_id is null;
  end if;
end
$$;

alter table public.vault_accounts
  drop constraint if exists vault_accounts_group_id_fkey;

alter table public.vault_accounts
  add constraint vault_accounts_group_id_fkey
  foreign key (group_id) references public.vault_account_groups(id) on delete cascade;

alter table public.vault_accounts alter column group_id set not null;

alter table public.vault_transactions
  drop constraint if exists vault_transactions_account_id_fkey;

alter table public.vault_transactions
  add constraint vault_transactions_account_id_fkey
  foreign key (account_id) references public.vault_accounts(id) on delete set null;

alter table public.vault_account_history
  drop constraint if exists vault_account_history_account_id_fkey;

alter table public.vault_account_history
  add constraint vault_account_history_account_id_fkey
  foreign key (account_id) references public.vault_accounts(id) on delete cascade;

alter table public.vault_recurring_items
  drop constraint if exists vault_recurring_items_account_id_fkey;

alter table public.vault_recurring_items
  add constraint vault_recurring_items_account_id_fkey
  foreign key (account_id) references public.vault_accounts(id) on delete set null;

update public.vault_transactions transaction
set category_name = coalesce(category.name, transaction.category_name, '其他')
from public.vault_categories category
where transaction.category_id = category.id;

update public.vault_transactions transaction
set account_name_snapshot = coalesce(transaction.account_name_snapshot, account.name),
    group_name_snapshot = coalesce(transaction.group_name_snapshot, account_group.name)
from public.vault_accounts account
join public.vault_account_groups account_group on account_group.id = account.group_id
where transaction.account_id = account.id;

insert into public.vault_sync_state (id, initialized, updated_at)
values (
  'global',
  exists (select 1 from public.vault_transactions)
    or exists (select 1 from public.vault_budgets)
    or exists (select 1 from public.vault_savings_goals)
    or exists (select 1 from public.vault_accounts where balance <> 0),
  now()
)
on conflict (id) do nothing;

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

  delete from public.vault_recurring_items;
  delete from public.vault_account_history;
  delete from public.vault_transactions;
  delete from public.vault_budgets;
  delete from public.vault_savings_goals;
  delete from public.vault_accounts;
  delete from public.vault_account_groups;

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

create or replace function public.ourhome_vault_create_transaction(
  p_date date,
  p_type text,
  p_amount numeric,
  p_category_name text,
  p_account_id uuid,
  p_tag text default null,
  p_note text default null,
  p_source text default 'manual'
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_account public.vault_accounts%rowtype;
  v_group_name text;
  v_category_id uuid;
  v_transaction_id uuid;
  v_delta numeric;
begin
  if p_type not in ('income', 'expense') then raise exception '收支类型不正确'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '金额必须大于零'; end if;

  select * into v_account
  from public.vault_accounts
  where id = p_account_id
  for update;
  if not found then raise exception '找不到指定账户'; end if;

  select name into v_group_name from public.vault_account_groups where id = v_account.group_id;
  select id into v_category_id
  from public.vault_categories
  where type = p_type and name = coalesce(nullif(btrim(p_category_name), ''), '其他')
  order by sort_order
  limit 1;

  v_delta := case
    when v_account.is_debt and p_type = 'expense' then p_amount
    when v_account.is_debt and p_type = 'income' then -p_amount
    when p_type = 'income' then p_amount
    else -p_amount
  end;

  update public.vault_accounts
  set balance = balance + v_delta, updated_at = now()
  where id = v_account.id;

  insert into public.vault_account_history (account_id, balance, change, reason)
  values (v_account.id, v_account.balance + v_delta, v_delta, 'transaction');

  insert into public.vault_transactions (
    date, type, amount, category_id, category_name, account_id,
    account_name_snapshot, group_name_snapshot, tag, note, source
  ) values (
    coalesce(p_date, current_date), p_type, p_amount, v_category_id,
    left(coalesce(nullif(btrim(p_category_name), ''), '其他'), 80),
    v_account.id, v_account.name, v_group_name,
    left(coalesce(p_tag, ''), 40), left(coalesce(p_note, ''), 500),
    left(coalesce(nullif(p_source, ''), 'manual'), 40)
  ) returning id into v_transaction_id;

  insert into public.vault_sync_state (id, initialized, updated_at)
  values ('global', true, now())
  on conflict (id) do update set initialized = true, updated_at = excluded.updated_at;

  return v_transaction_id;
end
$$;

create or replace function public.ourhome_vault_delete_transaction(p_transaction_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_transaction public.vault_transactions%rowtype;
  v_account public.vault_accounts%rowtype;
  v_delta numeric;
begin
  select * into v_transaction
  from public.vault_transactions
  where id = p_transaction_id
  for update;
  if not found then return false; end if;

  if v_transaction.account_id is not null then
    select * into v_account
    from public.vault_accounts
    where id = v_transaction.account_id
    for update;
    if found then
      v_delta := case
        when v_account.is_debt and v_transaction.type = 'expense' then -v_transaction.amount
        when v_account.is_debt and v_transaction.type = 'income' then v_transaction.amount
        when v_transaction.type = 'income' then -v_transaction.amount
        else v_transaction.amount
      end;
      update public.vault_accounts
      set balance = balance + v_delta, updated_at = now()
      where id = v_account.id;
      insert into public.vault_account_history (account_id, balance, change, reason)
      values (v_account.id, v_account.balance + v_delta, v_delta, 'delete_transaction');
    end if;
  end if;

  delete from public.vault_transactions where id = p_transaction_id;
  update public.vault_sync_state set updated_at = now() where id = 'global';
  return true;
end
$$;

revoke all on table public.vault_account_groups from anon, authenticated;
revoke all on table public.vault_sync_state from anon, authenticated;
revoke all on table public.vault_accounts from anon, authenticated;
revoke all on table public.vault_account_history from anon, authenticated;
revoke all on table public.vault_categories from anon, authenticated;
revoke all on table public.vault_transactions from anon, authenticated;
revoke all on table public.vault_budgets from anon, authenticated;
revoke all on table public.vault_recurring_items from anon, authenticated;
revoke all on table public.vault_savings_goals from anon, authenticated;
revoke all on table public.vault_husband_phrases from anon, authenticated;

grant select, insert, update, delete on table public.vault_account_groups to service_role;
grant select, insert, update, delete on table public.vault_sync_state to service_role;
grant select, insert, update, delete on table public.vault_accounts to service_role;
grant select, insert, update, delete on table public.vault_account_history to service_role;
grant select, insert, update, delete on table public.vault_categories to service_role;
grant select, insert, update, delete on table public.vault_transactions to service_role;
grant select, insert, update, delete on table public.vault_budgets to service_role;
grant select, insert, update, delete on table public.vault_recurring_items to service_role;
grant select, insert, update, delete on table public.vault_savings_goals to service_role;
grant select, insert, update, delete on table public.vault_husband_phrases to service_role;

revoke all on function public.ourhome_vault_replace_state(jsonb) from public, anon, authenticated;
revoke all on function public.ourhome_vault_create_transaction(date, text, numeric, text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.ourhome_vault_delete_transaction(uuid) from public, anon, authenticated;
grant execute on function public.ourhome_vault_replace_state(jsonb) to service_role;
grant execute on function public.ourhome_vault_create_transaction(date, text, numeric, text, uuid, text, text, text) to service_role;
grant execute on function public.ourhome_vault_delete_transaction(uuid) to service_role;
