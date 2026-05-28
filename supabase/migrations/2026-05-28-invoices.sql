-- Migration: invoice persistence + per-customer net-terms.
-- Run in the Supabase SQL editor after applying earlier migrations.

-- 1) Customer net-terms: previously kept local-only because the column
--    didn't exist remotely. Add it now so the buyer's payment terms
--    sync across devices.
alter table public.customers
  add column if not exists net_terms_days integer not null default 30
  check (net_terms_days >= 0);

-- 2) Invoices: one row per generated invoice. status is enforced by the
--    application; overdue is derived (issued + past net-terms), never
--    stored. payload holds the full collectData() blob so re-rendering
--    is identical to drafting.
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  number text not null,
  status text not null default 'draft'
    check (status in ('draft', 'issued', 'paid')),
  date date not null,
  due_date date,
  customer_id uuid references public.customers(id) on delete set null,
  buyer jsonb not null default '{}'::jsonb,
  seller jsonb not null default '{}'::jsonb,
  total numeric(14,2) not null default 0,
  currency text not null default 'USD' check (currency in ('USD', 'LBP')),
  payload jsonb not null default '{}'::jsonb,
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  paid_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists invoices_user_date_idx
  on public.invoices (user_id, date desc);
create index if not exists invoices_user_status_idx
  on public.invoices (user_id, status);
create index if not exists invoices_customer_idx
  on public.invoices (customer_id);

drop trigger if exists invoices_touch_updated_at on public.invoices;
create trigger invoices_touch_updated_at
before update on public.invoices
for each row execute function public.touch_updated_at();

alter table public.invoices enable row level security;

drop policy if exists "Invoices are owned by the signed-in user" on public.invoices;
create policy "Invoices are owned by the signed-in user"
on public.invoices
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.invoices to authenticated;
