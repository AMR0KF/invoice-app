-- Invoice Maker Supabase schema
-- Run this in the Supabase SQL editor after creating your project.

create extension if not exists pgcrypto;

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  address text not null default '',
  phone text not null default '',
  email text not null default '',
  individual_disclaimer boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  address text not null default '',
  phone text not null default '',
  email text not null default '',
  net_terms_days integer not null default 30 check (net_terms_days >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  number text not null,
  status text not null default 'draft' check (status in ('draft', 'issued', 'paid')),
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

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  currency text not null default 'USD' check (currency in ('USD', 'LBP')),
  ui_language text not null default 'bi' check (ui_language in ('en', 'ar', 'bi')),
  doc_language text not null default 'bi' check (doc_language in ('en', 'ar', 'bi')),
  template text not null default 'aurora' check (template in ('aurora', 'aurora_v2', 'meridian', 'meridian_v2', 'obsidian', 'classic')),
  vat_pct numeric(5,2) not null default 0 check (vat_pct >= 0 and vat_pct <= 100),
  theme text not null default 'dark' check (theme in ('dark', 'light')),
  updated_at timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists companies_touch_updated_at on public.companies;
create trigger companies_touch_updated_at
before update on public.companies
for each row execute function public.touch_updated_at();

drop trigger if exists customers_touch_updated_at on public.customers;
create trigger customers_touch_updated_at
before update on public.customers
for each row execute function public.touch_updated_at();

drop trigger if exists user_settings_touch_updated_at on public.user_settings;
create trigger user_settings_touch_updated_at
before update on public.user_settings
for each row execute function public.touch_updated_at();

drop trigger if exists invoices_touch_updated_at on public.invoices;
create trigger invoices_touch_updated_at
before update on public.invoices
for each row execute function public.touch_updated_at();

create index if not exists invoices_user_date_idx
  on public.invoices (user_id, date desc);
create index if not exists invoices_user_status_idx
  on public.invoices (user_id, status);
create index if not exists invoices_customer_idx
  on public.invoices (customer_id);

alter table public.companies enable row level security;
alter table public.customers enable row level security;
alter table public.user_settings enable row level security;
alter table public.invoices enable row level security;

drop policy if exists "Companies are owned by the signed-in user" on public.companies;
create policy "Companies are owned by the signed-in user"
on public.companies
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Customers are owned by the signed-in user" on public.customers;
create policy "Customers are owned by the signed-in user"
on public.customers
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Settings are owned by the signed-in user" on public.user_settings;
create policy "Settings are owned by the signed-in user"
on public.user_settings
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Invoices are owned by the signed-in user" on public.invoices;
create policy "Invoices are owned by the signed-in user"
on public.invoices
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.companies to authenticated;
grant select, insert, update, delete on public.customers to authenticated;
grant select, insert, update, delete on public.user_settings to authenticated;
grant select, insert, update, delete on public.invoices to authenticated;
