-- OurHome 搜索索引与数据库权限收口

create extension if not exists pg_trgm with schema extensions;

create index if not exists messages_session_visible_created_idx
  on public.messages (session_id, visible, created_at);

create index if not exists messages_visible_content_trgm_idx
  on public.messages using gin (content extensions.gin_trgm_ops)
  where visible = true;

create index if not exists letters_parent_id_idx
  on public.letters (parent_id);

create index if not exists vault_account_history_account_id_idx
  on public.vault_account_history (account_id);

create index if not exists vault_recurring_items_account_id_idx
  on public.vault_recurring_items (account_id);

create index if not exists vault_recurring_items_category_id_idx
  on public.vault_recurring_items (category_id);

create index if not exists vault_transactions_account_id_idx
  on public.vault_transactions (account_id);

create index if not exists vault_transactions_category_id_idx
  on public.vault_transactions (category_id);

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

notify pgrst, 'reload schema';
