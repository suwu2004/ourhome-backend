alter table public.settings
  add column if not exists home_bg_day_image_url text,
  add column if not exists home_bg_night_image_url text;
