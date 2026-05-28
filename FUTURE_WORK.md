# Future work

Backlog for the next pass on the Invoice Maker app. Each section is a
self-contained design + execution plan so a future contributor can pick
one up without rediscovering context.

---

## #7 — Email the invoice from the app

**Goal.** After the user generates a PDF, let them email it directly to the
buyer's address without leaving the page.

### UX
- New `Send to client` button in the action bar, enabled only after a PDF
  is generated.
- Click → small inline composer (slide-down panel under the button):
  - **To** prefilled from `buyer.email`, editable.
  - **Subject** templated, e.g. `Invoice INV-2026-014 from {seller.name}`.
  - **Body** templated short note in the active document language
    (`doc-lang`), referencing the grand total and any `notes`.
  - **Cc me** checkbox (sends a copy to `seller.email`).
- After send: toast `Sent to buyer@example.com`, set
  `currentInvoiceStatus = 'issued'` automatically.
- If send fails: keep the panel open with the error inline; the PDF is
  still already downloadable.

### Server / infra
- Add an `/api/send-invoice` POST endpoint (Flask + Vercel python
  function). Payload: `{ to, cc, subject, body, pdf_filename }`.
- Use **Resend** (`resend.com`, ~$0 for low volume) as the transactional
  provider. Why Resend over Postmark/SendGrid: simplest API, no domain
  verification gate for sandbox sends, generous free tier.
- Store `RESEND_API_KEY` as a Vercel env var. Locally read from
  `.env.local` (same pattern as Supabase config).
- Pull the PDF off `data/output/{filename}` and attach it. On Vercel the
  file lives in the writeable tmp dir from the same request that
  generated it — pipe the attachment through immediately rather than
  re-fetching by URL.
- Rate-limit per IP (Vercel has built-in; otherwise a small in-memory
  bucket on Flask).

### Logging
- Append every successful send to a new `data/sent_log.jsonl`:
  `{ts, invoice_number, to, status, message_id}`. This is the precursor
  to the **history** feature listed below.

### Failure modes
- Bounced address — Resend webhooks can post bounce events. Out of scope
  for the first cut; surface bounces in the next iteration once a real
  history view exists.
- PDF still being generated when user clicks send — disable the send
  button until `lastGeneratedPdf` is non-null (already tracked in JS).

### Effort
~4 hours, mostly UI polish + the email template.

---

## #8 — Recurring invoices

**Goal.** A user who bills the same customer every month should set the
invoice up once and let the system mint it on schedule.

### Prerequisites
1. **Server-side invoice persistence** does not exist today — the app
   only saves the PDF to `data/output/`. Recurrence needs a record per
   invoice (so the cron job can stamp a new copy). Add a new
   `data/invoices.json` (or a Supabase `invoices` table) with:
   ```
   { id, number, status, date, due_date, customer_id, seller_id,
     payload, created_at, sent_at, paid_at }
   ```
   The `payload` field is the full `collectData()` blob — that way the
   line items and totals are immutable and the renderer is the same code
   path as ad-hoc invoices.
2. **Customer payment terms** field — already added (`net_terms_days`),
   re-use as the default due-offset.

### Recurrence model
- A separate `recurrences` collection:
  ```
  { id, template_invoice_id, cadence, next_run_at, end_date, status }
  cadence: { every: 1, unit: 'month' | 'week' }
  status:  'active' | 'paused'
  ```
- When the user marks an invoice "make this recurring", capture
  `cadence`, `next_run_at`, optional `end_date`.

### Scheduler
- Vercel Cron job hits `/api/recurrences/tick` every 6 hours.
- Tick:
  1. Find all `recurrences` with `next_run_at <= now` and `status =
     active`.
  2. For each: clone the template invoice with a fresh number + today's
     date, optionally run the **#7 email-the-invoice** flow.
  3. Advance `next_run_at` by the cadence; if past `end_date`, set
     `status = 'completed'`.
- Idempotency: stamp each generated child invoice with
  `parent_recurrence_id` so a re-run within the same cycle doesn't
  duplicate.

### UI
- Sidebar of an invoice: `Recurring` toggle that opens a small panel
  (`Every 1 month, ending …`). Pause/resume in settings.
- Settings → new card `Recurring invoices` with the active list, next
  fire date, and a quick `Generate now` button.

### Effort
~1–2 days, dominated by the invoice-persistence migration. Recurrence
itself is small once that lands.

---

## Payment system

**Goal.** Buyer clicks a "Pay" link on the invoice (PDF or hosted web
view) and pays online. Status flips to `paid` automatically.

We have two viable shapes — pick based on customer geography and time
budget. The **lighter path** is recommended first; the deeper path is a
yearlater migration.

### Option A (recommended) — Stripe-hosted checkout link
- New `/api/create-payment-link` endpoint hits Stripe's
  **Payment Links** API (single call). No on-app card form, no PCI
  scope, no UI we have to maintain.
- The Stripe link's success URL routes back to
  `/api/stripe/webhook` which receives `checkout.session.completed`,
  looks up the invoice by `client_reference_id` (= our invoice number),
  flips status to `paid`, sets `paid_at`.
- Surfaces:
  - PDF: when status is `issued` and a payment link exists, render a
    "Pay online" button on the PDF (already a placeholder in the
    template, would just become a real anchor).
  - Email (#7): the same link in the email body.
  - In-app: button on the invoice sidebar that opens the link in a new
    tab.
- Stripe account setup: connect on Stripe dashboard, configure
  `payouts` to user's bank. **Multi-tenant note** — if multiple users
  share the deployed instance, each user needs their own connected
  account (Stripe Connect Express). For a single-user/single-tenant
  deploy, a single Stripe account suffices.
- Currency: Stripe supports USD natively. **LBP is not supported by
  Stripe.** LBP invoices skip the payment-link UI; show a tooltip
  explaining why.

### Option B — Lebanese alternatives
The customer base is bilingual EN/AR and uses LBP. Stripe LBP is dead.
Local options:
- **Areeba** — Lebanese gateway, supports LBP + USD, has a hosted
  checkout. Lower fees in-country but heavier paperwork to onboard.
- **Whish Money** — popular Lebanese P2P / merchant app, generates
  payment requests with a deep link. Lighter onboarding, lower
  ceiling.
- **Wish Money's Open API** — undocumented publicly; partnership
  required.
- **Wired bank transfer** — already supported via the `notes` field
  ("Account #…"). For LBP-only flows, this stays the fallback.

For a v1 that ships fast: **Stripe for USD, manual wire instructions in
the notes for LBP, and a stub for Areeba/Whish behind a feature flag.**

### Status model implications
- New status: `pending_payment` between `issued` and `paid`, set when a
  Stripe payment link is created but not yet completed.
- The webhook is the source of truth — never trust client-side
  "I just paid" reports.

### Effort
- Option A (Stripe Payment Links + webhook): ~6 hours including
  testing in Stripe test mode.
- Option B (local provider): unknown — depends on their onboarding /
  API documentation quality. Plan for 2–3 days.

---

## Linking with an external app instead

If building a payment flow in-house is too much, the cleanest external
integration is **Stripe Invoicing** (not the same as Payment Links).

Stripe Invoicing has its own UI for status tracking, dunning, and
recurring billing. Our flow would change to:
1. User generates a draft locally (same as today).
2. "Send via Stripe" button creates the invoice via Stripe API with
   our line items.
3. Stripe takes over: hosts the buyer-facing page, sends the email,
   tracks payment, sends reminders.
4. Our app becomes a thin overview — webhooks keep our local status
   field in sync.

Pros: ~zero ongoing maintenance, professional dunning, multi-currency
support (within Stripe's coverage). Cons: every user needs a Stripe
account, monthly minimum fees can sting at low volume, no LBP.

A clean alternative for LBP-first users: **Wave** (free) or
**Zoho Invoice** (free tier, generous). Both have APIs. Our app could
*push* finalized invoices to Wave/Zoho and let them handle status +
payment, leaving us as the editor + designer of the document. This is
a substantial pivot — flagging here so it's a deliberate decision, not
a default.

---

## Server-side invoice history (prerequisite for #8 + payments)

Pulled out separately because three features depend on it. Add a thin
table:
```
data/invoices.json  -> [{ id, number, status, date, due_date,
                          customer_id, seller_id, payload,
                          created_at, sent_at, paid_at, ... }, ...]
```
or a Supabase `invoices` table with the same shape. Endpoints:
- `POST /api/invoices` — write a finalized invoice (call this after a
  successful PDF gen).
- `GET /api/invoices` — list, with filters by status + customer.
- `PATCH /api/invoices/{id}` — update status / paid_at.

Once this exists:
- Recurrence (#8) can clone records.
- Payments webhook can flip status.
- A future overdue dashboard can show `WHERE status = 'issued' AND
  due_date < today`.
- Per-customer outstanding-balance summaries become trivial.

---

## Smaller follow-ups

These don't need their own section but are worth tracking:

- **Customer.net_terms_days persistence on Supabase.** Currently the
  field is local-only because the remote `customers` table doesn't have
  the column. Add a migration:
  `ALTER TABLE customers ADD COLUMN net_terms_days int DEFAULT 30;`
  Then drop the local-only carve-out in `saveCustomer()`.
- **Company logo upload** for branded PDFs. Persist as base64 or to
  Supabase Storage; flow into the PDF templates' header.
- **Customer-side autocomplete on buyer name.** The dropdown exists but
  could be smarter (fuzzy match, recently-used).
- **Settings → bulk CSV export** of companies + customers, for backup.

---

*Generated 2026-05-28. Update as items move through.*
