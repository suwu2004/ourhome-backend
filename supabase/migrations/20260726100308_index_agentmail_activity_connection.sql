create index if not exists agentmail_activity_connection_id_idx
  on public.agentmail_activity (connection_id)
  where connection_id is not null;
