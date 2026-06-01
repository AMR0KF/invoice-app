-- Migration: supersede pointer + per-user unique invoice numbers.
--
-- Part of the invoice redraft (see .planning/INVOICE_REDRAFT.md).
-- After this, the DB is the authority on number uniqueness — the
-- client computes a next number optimistically and retries on conflict.
-- "Editing" an issued invoice will go through a supersede flow that
-- voids the original and points it at the replacement via
-- superseded_by, preserving the audit trail.
--
-- Run AFTER:
--   2026-05-28-invoices.sql
--   2026-05-29-invoice-void-status.sql
--   2026-05-29-invoice-company-link.sql

alter table public.invoices
  add column if not exists superseded_by uuid
  references public.invoices(id) on delete set null;

create index if not exists invoices_superseded_by_idx
  on public.invoices (superseded_by);

-- Number uniqueness per user. Prevents two devices from racing to
-- issue the same number. The client retries with computeNext + 1
-- on a 23505 unique_violation.
create unique index if not exists invoices_user_number_unique
  on public.invoices (user_id, number);
