alter table public.toybox_runs drop constraint if exists toybox_runs_game_check;

alter table public.toybox_runs
  add constraint toybox_runs_game_check
  check (game in ('harmony','drawing','secret','gomoku'));
