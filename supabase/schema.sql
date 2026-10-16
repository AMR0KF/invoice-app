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
  role text not null default 'owner' check (role in ('owner', 'driver')),
  -- assigned_truck_id is added via ALTER below (FK target `trucks` is
  -- created after this table to keep the file in dependency order).
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

-- ───────────────────────────────────────────────────────────────────────────
-- Operations layer: trucks / jobs / expenses + owner/driver roles.
-- See supabase/migrations/2026-06-17-jobs-trucks-expenses.sql for the seed
-- (two trucks, amro=owner, amer=driver assigned Truck 1). These tables are
-- WORKSPACE-SHARED across authenticated users (owner must see/invoice the
-- driver's jobs); user_id is provenance only. Invoices/customers/companies
-- stay per-user (above).
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.trucks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  label text not null,
  plate text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  job_number text not null unique,
  date date not null default current_date,
  truck_id uuid references public.trucks(id) on delete set null,
  -- customer_id is a best-effort back-link; the customer_* snapshot is the
  -- workspace-readable buyer (customers stay per-user RLS).
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text not null default '',
  customer_address text not null default '',
  customer_phone text not null default '',
  customer_email text not null default '',
  customer_net_terms_days integer not null default 30,
  job_types text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'done', 'cancelled')),
  notes text not null default '',
  invoice_id uuid references public.invoices(id) on delete set null,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null default current_date,
  truck_id uuid references public.trucks(id) on delete set null,
  job_id uuid references public.jobs(id) on delete set null,
  category text not null default 'other' check (category in ('fuel', 'labor', 'maintenance', 'other')),
  amount numeric(14,2) not null default 0,
  currency text not null default 'USD' check (currency in ('USD', 'LBP')),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- FKs that would be circular at CREATE time, added once both sides exist.
alter table public.user_settings
  add column if not exists assigned_truck_id uuid
  references public.trucks(id) on delete set null;
alter table public.invoices
  add column if not exists job_id uuid
  references public.jobs(id) on delete set null;

drop trigger if exists jobs_touch_updated_at on public.jobs;
create trigger jobs_touch_updated_at
before update on public.jobs
for each row execute function public.touch_updated_at();

drop trigger if exists expenses_touch_updated_at on public.expenses;
create trigger expenses_touch_updated_at
before update on public.expenses
for each row execute function public.touch_updated_at();

-- Privilege guard: role/assigned_truck_id may only be set by the seed/admin
-- (postgres / service_role), never self-promoted via the PostgREST API.
create or replace function public.guard_user_settings_privileged_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user = 'authenticated'
     and (new.role is distinct from old.role
          or new.assigned_truck_id is distinct from old.assigned_truck_id) then
    raise exception 'role and assigned_truck_id may only be changed by an administrator';
  end if;
  return new;
end;
$$;

drop trigger if exists user_settings_guard_privileged on public.user_settings;
create trigger user_settings_guard_privileged
before update on public.user_settings
for each row execute function public.guard_user_settings_privileged_columns();

create index if not exists jobs_date_idx      on public.jobs (date desc);
create index if not exists jobs_truck_idx     on public.jobs (truck_id);
create index if not exists jobs_customer_idx  on public.jobs (customer_id);
create index if not exists jobs_invoice_idx   on public.jobs (invoice_id);
create index if not exists expenses_date_idx  on public.expenses (date desc);
create index if not exists expenses_truck_idx on public.expenses (truck_id);
create index if not exists expenses_job_idx   on public.expenses (job_id);
create index if not exists invoices_job_idx   on public.invoices (job_id);

alter table public.trucks   enable row level security;
alter table public.jobs     enable row level security;
alter table public.expenses enable row level security;

drop policy if exists "Trucks are shared across the workspace" on public.trucks;
create policy "Trucks are shared across the workspace"
on public.trucks for all to authenticated
using (true) with check (true);

drop policy if exists "Jobs are shared across the workspace" on public.jobs;
create policy "Jobs are shared across the workspace"
on public.jobs for all to authenticated
using (true) with check (true);

drop policy if exists "Expenses are shared across the workspace" on public.expenses;
create policy "Expenses are shared across the workspace"
on public.expenses for all to authenticated
using (true) with check (true);

grant select, insert, update, delete on public.trucks   to authenticated;
grant select, insert, update, delete on public.jobs     to authenticated;
grant select, insert, update, delete on public.expenses to authenticated;
