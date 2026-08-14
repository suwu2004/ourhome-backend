do $migration$
declare
  function_sql text;
  old_marker constant text := '''toybox_runs'',''toybox_events'',''theater_rules'',';
  new_marker constant text := '''toybox_runs'',''toybox_events'',''theater_rules'',''lorebooks'',''lorebook_entries'',';
begin
  function_sql := pg_get_functiondef('public.ourhome_backup_to_neon()'::regprocedure);
  if position(new_marker in function_sql) > 0 then
    return;
  end if;
  if position(old_marker in function_sql) = 0 then
    raise exception 'ourhome_backup_to_neon table marker not found';
  end if;
  function_sql := replace(function_sql, old_marker, new_marker);
  execute function_sql;
end
$migration$;
