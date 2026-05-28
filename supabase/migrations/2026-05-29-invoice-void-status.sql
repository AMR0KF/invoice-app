-- Migration: add 'void' to the invoices.status check constraint.
-- Voided records survive in the table so the audit trail / invoice
-- numbers stay continuous; only true drafts can be hard-deleted by
-- the client (see app.js — deleteCurrentInvoice / deleteInvoiceFromList).
--
-- Run AFTER 2026-05-28-invoices.sql.

alter table public.invoices
  drop constraint if exists invoices_status_check;

alter table public.invoices
  add constraint invoices_status_check
  check (status in ('draft', 'issued', 'paid', 'void'));
