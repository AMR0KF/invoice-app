-- Allow 'aurora_v2' as a template option in user_settings.
-- Run this in the Supabase SQL editor on the production project.
alter table public.user_settings
  drop constraint if exists user_settings_template_check;

alter table public.user_settings
  add constraint user_settings_template_check
  check (template in ('aurora', 'aurora_v2', 'meridian', 'meridian_v2', 'obsidian', 'classic'));
