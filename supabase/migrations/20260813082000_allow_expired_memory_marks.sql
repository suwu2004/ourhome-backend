-- Layered-memory consolidation settles elapsed working marks as "expired".
-- Keep the original lifecycle values and add the state used by the consolidator.
alter table public.memory_marks
  drop constraint if exists memory_marks_status_check;

alter table public.memory_marks
  add constraint memory_marks_status_check
  check (status in ('active', 'continued', 'resolved', 'archived', 'expired'));
