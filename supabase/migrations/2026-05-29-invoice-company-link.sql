-- Migration: link invoices to their seller company by foreign key.
-- Lets the Companies page pivot reliably instead of relying on a name
-- match against payload.seller.name. New invoices written by the client
-- include company_id; older rows fall back to the name match for
-- display until they're re-issued.
--
-- Run AFTER 2026-05-28-invoices.sql and 2026-05-29-invoice-void-status.sql.

alter table public.invoices
  add column if not exists company_id uuid
  references public.companies(id) on delete set null;

create index if not exists invoices_company_idx
  on public.invoices (company_id);
