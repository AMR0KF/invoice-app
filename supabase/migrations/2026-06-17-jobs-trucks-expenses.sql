-- Migration: trucks, jobs, expenses + user roles + invoice→job link.
--
-- Adds a shared "operations" layer (trucks / jobs / expenses) on top of the
-- existing per-user invoicing app, plus owner/driver roles. Run in the
-- Supabase SQL editor AFTER all earlier migrations.
--
-- WORKSPACE MODEL NOTE -------------------------------------------------------
-- trucks/jobs/expenses are SHARED across the workspace's authenticated users
-- (owner + driver). An owner must see — and issue invoices from — jobs that a
-- driver created, so strict per-user isolation would break the core flow.
-- These tables keep a user_id column purely for provenance ("who created
-- this row"); RLS grants every authenticated user full access. The existing
-- invoices / customers / companies tables stay per-user and are untouched.
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;

-- ── Trucks ──────────────────────────────────────────────────────────────────
create table if not exists public.trucks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  label text not null,
  plate text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now()
);

-- ── Jobs ────────────────────────────────────────────────────────────────────
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  job_number text not null unique,
  date date not null default current_date,
  truck_id uuid references public.trucks(id) on delete set null,
  -- customer_id is a best-effort back-link; customers stay per-user (RLS), so a
  -- workspace peer can't always read it. The customer_* snapshot below is the
  -- workspace-readable source of truth for the job's buyer (and the issued
  -- invoice's buyer).
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
-- Idempotent guards in case an earlier draft of this migration created jobs
-- without the snapshot columns (the inline `unique` above covers job_number on
-- a fresh create).
alter table public.jobs add column if not exists customer_name text not null default '';
alter table public.jobs add column if not exists customer_address text not null default '';
alter table public.jobs add column if not exists customer_phone text not null default '';
alter table public.jobs add column if not exists customer_email text not null default '';
alter table public.jobs add column if not exists customer_net_terms_days integer not null default 30;

-- ── Expenses ────────────────────────────────────────────────────────────────
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

-- ── user_settings: role + assigned truck (read once on login) ────────────────
alter table public.user_settings
  add column if not exists role text not null default 'owner'
  check (role in ('owner', 'driver'));
alter table public.user_settings
  add column if not exists assigned_truck_id uuid
  references public.trucks(id) on delete set null;

-- ── invoices: link back to the job it was issued from ────────────────────────
alter table public.invoices
  add column if not exists job_id uuid
  references public.jobs(id) on delete set null;

-- ── updated_at triggers (reuse the existing touch_updated_at function) ───────
drop trigger if exists jobs_touch_updated_at on public.jobs;
create trigger jobs_touch_updated_at
before update on public.jobs
for each row execute function public.touch_updated_at();

drop trigger if exists expenses_touch_updated_at on public.expenses;
create trigger expenses_touch_updated_at
before update on public.expenses
for each row execute function public.touch_updated_at();

-- Privilege guard: role + assigned_truck_id are security columns. The
-- user_settings RLS policy lets a user update their own row, so without this a
-- driver could self-promote via the API: update user_settings set role='owner'.
-- Block changes to these two columns when the request runs as the PostgREST
-- `authenticated` role; the seed/admin (postgres / service_role) is unaffected,
-- and the app's normal settings upsert never sends these columns (NEW = OLD,
-- so the trigger no-ops on legitimate writes).
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

-- ── Indexes ──────────────────────────────────────────────────────────────────
create index if not exists jobs_date_idx      on public.jobs (date desc);
create index if not exists jobs_truck_idx     on public.jobs (truck_id);
create index if not exists jobs_customer_idx  on public.jobs (customer_id);
create index if not exists jobs_invoice_idx   on public.jobs (invoice_id);
create index if not exists expenses_date_idx  on public.expenses (date desc);
create index if not exists expenses_truck_idx on public.expenses (truck_id);
create index if not exists expenses_job_idx   on public.expenses (job_id);
create index if not exists invoices_job_idx   on public.invoices (job_id);

-- ── RLS: workspace-shared (any authenticated user) ──────────────────────────
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

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.trucks   to authenticated;
grant select, insert, update, delete on public.jobs     to authenticated;
grant select, insert, update, delete on public.expenses to authenticated;

-- ── Seed: two trucks + roles + the driver's assigned truck ───────────────────
-- Idempotent. Resolves the two seeded auth users by email. Trucks are owned
-- (provenance only) by the owner. amro → owner, amer → driver assigned Truck 1.
do $$
declare
  owner_id  uuid;
  driver_id uuid;
  truck1_id uuid;
  truck2_id uuid;
begin
  select id into owner_id  from auth.users where email = 'amro@invoice.local';
  select id into driver_id from auth.users where email = 'amer@invoice.local';

  -- Seed the two workspace trucks exactly once.
  if not exists (select 1 from public.trucks) and coalesce(owner_id, driver_id) is not null then
    insert into public.trucks (user_id, label) values (coalesce(owner_id, driver_id), 'Truck 1')
      returning id into truck1_id;
    insert into public.trucks (user_id, label) values (coalesce(owner_id, driver_id), 'Truck 2')
      returning id into truck2_id;
  else
    select id into truck1_id from public.trucks where label = 'Truck 1' order by created_at limit 1;
    select id into truck2_id from public.trucks where label = 'Truck 2' order by created_at limit 1;
  end if;

  -- Owner role for amro.
  if owner_id is not null then
    insert into public.user_settings (user_id, role)
      values (owner_id, 'owner')
      on conflict (user_id) do update set role = 'owner';
  end if;

  -- Driver role + assigned Truck 1 for amer.
  if driver_id is not null then
    insert into public.user_settings (user_id, role, assigned_truck_id)
      values (driver_id, 'driver', truck1_id)
      on conflict (user_id) do update set role = 'driver', assigned_truck_id = truck1_id;
  end if;
end $$;
