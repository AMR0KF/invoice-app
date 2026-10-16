-- Migration: Add default_company_id to user_settings
-- Persists the user's active company profile across devices (desktop, tablet, mobile).

alter table public.user_settings
  add column if not exists default_company_id uuid references public.companies(id) on delete set null;
