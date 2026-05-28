# Plan — invoice list, duplicate, mark-paid + selected suggestions

Working checklist. Tick items as they land. Items are sized by what they
actually touch, not what they imply.

## Scope locked

Building: 1 (list + bulk mark-paid), 2 (duplicate), and suggestions
3, 4, 6, 7, 8, 1-as-grouping. Suggestion 9 (send reminder) → FUTURE_WORK.

## Non-goals

- Recurring invoices (#8 in FUTURE_WORK).
- Email-the-invoice (#7 in FUTURE_WORK).
- Stripe payments.
- Templates / save-as-template.
- Activity dashboard card.

These are documented but explicitly out of this round.

---

## Storage model

The hard truth: **invoices have never been persisted server-side**.
This round changes that. Same dual-mode pattern as customers/companies:

- **Local mode (`!supabaseActive()`):** localStorage key `inv_invoices`
  (array of invoice records).
- **Supabase mode:** new `public.invoices` table — migration in
  `supabase/migrations/2026-05-28-invoices.sql`.

Record shape (canonical, both modes):
```
{
  id:           uuid (supabase) or "iv"+timestamp (local)
  number:       "INV-2026-014"
  status:       "draft" | "issued" | "paid"
  date:         "YYYY-MM-DD"            // issue date
  due_date:     "YYYY-MM-DD" | null
  customer_id:  uuid | local-id | null  // FK to customers
  buyer:        { name, address, phone, email, net_terms_days }
  seller:       { name, address, phone, email }
  total:        number                  // grand total snapshot
  currency:     "USD" | "LBP"
  payload:      <full collectData blob> // for re-render / duplicate
  history:      [ { at, from, to } ]    // status transitions
  created_at, sent_at, paid_at
}
```

`payload` is the full `collectData()` snapshot — that way re-rendering
or duplicating an invoice is identical code to drafting one.

`history` is the per-invoice audit log (suggestion 8). Appended on every
status change, never rewritten.

---

## Step-by-step

### A — Persistence layer
- [ ] `supabase/migrations/2026-05-28-invoices.sql` — `invoices` table,
      indexes on (`user_id`, `status`, `date`), RLS policy mirroring
      customers. Also adds `net_terms_days int` to `customers` table to
      close the carve-out from the previous round.
- [ ] `server.py`: new `data/invoices.json`, `INVOICES_FILE` constant.
- [ ] `server.py`: `POST /api/invoices`, `GET /api/invoices`,
      `PATCH /api/invoices/<id>`, `DELETE /api/invoices/<id>`.
- [ ] `server.py`: hook into `/api/generate-pdf` — after successful PDF
      render, write the invoice record (in local mode). Atomic with the
      `next_invoice_number` bump.
- [ ] `app.js`: client-side `saveInvoice(record)`, `loadInvoices()`,
      `patchInvoice(id, fields)`, `deleteInvoice(id)` — dispatch on
      `supabaseActive()`.
- [ ] Client hook in `generateInvoice()` success path:
      build record from `collectData()` + totals + timestamps,
      call `saveInvoice`.

### B — List page

- [ ] New route `#/invoices` registered in `routeView()`.
- [ ] New `<section id="view-invoices" hidden>` markup at the same level
      as `view-invoice` and `view-settings`.
- [ ] Page head: back-to-editor button (mirrors settings pattern), title,
      "+ New invoice" CTA.
- [ ] Filter chips: `All · Draft · Issued · Overdue · Paid`. Active chip
      gets accent treatment. Counts in parentheses on desktop.
- [ ] Search box (matches `buyer.name` ∪ `number`).
- [ ] Sort controls (suggestion 7): dropdown on mobile,
      sortable column headers on desktop. Default `date desc`.
- [ ] Row: `[☐] # · Buyer · Date · Due · Total · Status badge · ⋯`.
- [ ] Status badge re-uses the existing `.status-badge` from the editor
      sidebar so visual language stays consistent.
- [ ] Row tap (not on the checkbox / not on ⋯) → load that invoice into
      the editor view via `loadInvoiceIntoEditor(id)`.

### C — Row actions
- [ ] `⋯` menu (or inline buttons on mobile): **Open**, **Duplicate**,
      **Mark paid** / **Mark issued** (context-aware), **Delete**.
- [ ] `markPaid(id)`: PATCH status='paid', paid_at=today, append history.
- [ ] `markIssued(id)`: same shape.
- [ ] `deleteInvoice(id)`: confirmation toast → DELETE.
- [ ] `duplicateInvoice(id)`: clone payload, bump number, reset
      date/status/paid_date, open in editor.

### D — Bulk actions
- [ ] Master checkbox in the list header.
- [ ] Per-row checkboxes, controlled state.
- [ ] Bulk action bar appears when N ≥ 1:
      `N selected · Mark paid · Duplicate · Delete · Cancel`.
- [ ] On mobile: bar is fixed to bottom (replaces the action-bar
      pattern from the editor).
- [ ] Bulk handlers run sequentially over selected ids; collect
      successes/failures; final toast `"3 marked paid, 1 failed"`.

### E — Editor "Duplicate this invoice"
- [ ] New button in the editor sidebar status section: "Duplicate".
- [ ] Disabled until the current invoice has been saved at least once
      (otherwise just clears the form).
- [ ] Same `duplicateInvoice(payload)` helper as the list-page button —
      payload arg lets it work without an id.

### Suggestion 3 — Auto-flip to `issued` on PDF generate
- [ ] After successful PDF gen, if `currentInvoiceStatus === 'draft'`,
      set it to `'issued'` and push the status transition into
      `history`.
- [ ] Setting in Workspace card: "Auto-mark issued on generate"
      (default ON). Stored at `inv_auto_issue`.

### Suggestion 4 — Customer detail page
- [ ] New route `#/customers/<id>` (or modal — see decision below).
- [ ] Page header: customer name, total invoiced, total outstanding,
      avg days-to-pay.
- [ ] List of invoices filtered to this customer (re-uses the same row
      component as the main list).
- [ ] Reachable from: a buyer-name cell in the list, and the buyer
      block on the editor (small "View history" link).

**Decision:** make it a route, not a modal. Route is shareable and
mobile-friendly.

### Suggestion 6 — CSV export
- [ ] Export button in the list page toolbar, exports the *currently
      filtered + sorted* set.
- [ ] CSV columns: `number, date, due_date, buyer, currency, total,
      status, paid_at, issued_age_days`.
- [ ] Generated client-side via Blob; no server round-trip.
- [ ] Filename: `invoices-{YYYY-MM-DD}.csv`.

### Suggestion 7 — Sort options
Folded into B above.

### Suggestion 8 — Status history per invoice
- [ ] On every status change (mark paid / mark issued / mark draft /
      auto-issue), append `{ at: ISO, from, to, by }` to `history`.
- [ ] On customer detail + list-row expand: render the history as a
      small inline timeline.

### Suggestion 1 — Per-customer grouping
- [ ] Toggle in the list toolbar: `Group by customer` (off by default).
- [ ] When on: rows are grouped under collapsible customer headers
      showing `name · total outstanding · # of invoices`.
- [ ] Outstanding total = sum of (status `issued` or `overdue`).

### FUTURE_WORK — Suggestion 9
- [ ] Append a "Send reminder" section to FUTURE_WORK.md.

---

## Mobile UI checkpoints (don't forget)

- [ ] Topbar: list-page reachable via a new icon next to the gear (not
      the segmented pill — that's desktop only post-refactor).
- [ ] List rows: stack secondary info (`Date · Due`) on a second line,
      keep the buyer name + total + status on the primary line.
- [ ] Filter chips: horizontal scroll if they overflow, never wrap.
- [ ] Sort: dropdown menu (`Sort by ↓ Date desc`) — sortable column
      headers don't exist on mobile.
- [ ] Bulk action bar: fixed bottom, glass treatment to match
      `mobile-action-bar`. Hidden on settings page same as the existing
      action bar.
- [ ] Customer detail page: same single-column layout that settings
      uses on mobile.
- [ ] Row `⋯` menu: opens as a bottom sheet on mobile, a small
      dropdown on desktop. (Or — simpler — inline buttons on mobile
      so we skip the menu entirely. Reassess after first cut.)

---

## Verification protocol

After each step, run a puppeteer probe in `.verify/`:
- Step A: POST → GET → PATCH → DELETE round-trip via fetch.
- Step B: navigate to `#/invoices`, screenshot at mobile + desktop,
      filter chips, search box.
- Step C: mark-paid a single record, assert badge flip + paid_at.
- Step D: bulk mark-paid 3 records.
- Suggestions: small probe per feature confirming the UI surface.

Commit at: end of A, end of D, after all suggestions, and after the
final mobile pass.

## Open questions / decisions log

- **Auto-issue default:** ON. Most invoices end with sending the PDF.
  Users who want to keep something as a draft after generating can
  flip it back; cheap to do.
- **Number gaps:** out of scope this round. Toast on number edit
  exists already.
- **Number-bump and invoice-write atomicity:** the existing
  `/api/generate-pdf` already increments the number; we add the
  invoice write to the same handler so they're transactional from
  the client's POV (one network call).
- **Delete an issued invoice:** allowed, with a confirmation. We don't
  preserve immutability — accountants might want a "void" status
  instead. Punt to FUTURE_WORK if real users ask.
