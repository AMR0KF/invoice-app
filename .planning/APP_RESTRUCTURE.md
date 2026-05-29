# Plan — App restructure: home, customers, companies, financial

Working brief for the implementer. Three pieces:

1. **Hub-and-spoke navigation.** Add a real **Home** landing page that
   funnels into Editor / Invoices / Customers / Companies / Financial.
   The current top-bar nav stays as fast-switching, but `#/` becomes a
   meaningful destination instead of a fallback redirect to the editor.
2. **Customers and Companies become first-class pages**, each with a
   list view and a detail view that shows the invoices belonging to it.
3. **Financial dashboard** at `#/financial` — totals, outstanding,
   overdue, paid this month / YTD, top customers, currency breakdown.

Plus a small defensive fix for the number / banner desync visible in the
recent screenshot.

## Non-goals

- Recurring invoices (`FUTURE_WORK.md` #8).
- Email-the-invoice (`FUTURE_WORK.md` #7).
- Stripe / payment links.
- New invoice template designs.
- Account-level multi-tenant (one Supabase user = one workspace stays).
- Charts library / heavy data viz. Financial section uses native
  numbers + the existing card layout. No chart.js, no recharts.

---

## Part A — Defensive number / banner sync (small, ship first)

### The bug

Screenshot (post-overhaul) showed `#inv-num = INV-2026-002` while the
sidebar banner read `EDITING INV-2026-001`. The new input listener at
[app.js:91](../app.js#L91) breaks the binding only on **user-typed**
changes to `#inv-num`. Programmatic `.value =` assignments — e.g.
[setInvoiceNumber](../app.js#L981) called during boot or after a
generate — do not fire the `input` event, so a programmatic divergence
between field and `editor.boundNumber` slips past.

The new code already has the right check inside `setInvoiceNumber`
([app.js:991](../app.js#L991)). The hole is that *not every code path
that changes the number goes through `setInvoiceNumber`* — and even
when it does, the function does NOT verify the field-to-bound
consistency *before* it runs (only after). One stale invocation order
out of band leaves the editor in the screenshot state.

### Fix

Add a single helper `reconcileEditorBinding()` that runs as the **end
of `renderEditingBanner`**:

```js
function reconcileEditorBinding() {
  if (editor.mode !== 'editing') return;
  const fieldValue = (document.getElementById('inv-num')?.value || '').trim();
  if (!fieldValue || !editor.boundNumber) return;
  if (fieldValue !== editor.boundNumber) {
    // Banner and field disagree — defensive break. Treat the field as
    // the user's intent; binding was stale.
    setEditorMode('new');
  }
}
```

Call it from:
- The end of `renderEditingBanner()` ([app.js:2677](../app.js#L2677))
  — so any render of the banner double-checks consistency.
- Inside `routeView()` ([app.js:295](../app.js#L295)) when the editor
  view becomes visible — catches reload-into-editor with a stale
  binding from a half-restored session.

Do not call it from `setInvoiceNumber` (would be redundant and could
recurse). The render pass is the right gate.

### Acceptance

- Repro the screenshot state (manually force `editor.boundNumber = 'X'`
  in DevTools while `#inv-num` has `Y`) → the next `renderEditingBanner`
  call unbinds and hides the banner.
- Boot path: open an invoice from list → reload page → editor view
  shows a clean draft, never a stale "EDITING X" with mismatched field.

This is ~15 lines. Ship as its own commit.

---

## Part B — Home page (`#/home`)

### Route

- New hash: `#/home`. Default landing route — change the
  `goToInvoice()` fallback so the empty hash (`#` or `#/`) goes to
  `#/home` instead of straight to the editor.
- Top-bar nav gains a "Home" item, placed first. The existing
  Editor/Invoices/Settings remain.

### Layout

Single page with a hero header (workspace name / signed-in user) and a
grid of action tiles:

```
┌──────────────────────────────────────────────────────────┐
│  Hi {name}.  This month: 12 invoices · $14,320 outstanding│
├──────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ + New        │  │ Invoices     │  │ Customers    │    │
│  │   invoice    │  │  view all    │  │  manage list │    │
│  └──────────────┘  └──────────────┘  └──────────────┘    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ Companies    │  │ Financial    │  │ Settings     │    │
│  │  seller side │  │  dashboard   │  │              │    │
│  └──────────────┘  └──────────────┘  └──────────────┘    │
├──────────────────────────────────────────────────────────┤
│  Recent activity                                          │
│   • Issued INV-2026-014 → Acme Co. (yesterday)            │
│   • Paid INV-2026-011 (3 days ago)                        │
│   • Voided INV-2026-008 (5 days ago)                      │
└──────────────────────────────────────────────────────────┘
```

The hero stat line is computed from the in-memory `invoices` list — no
new endpoint. Recent activity is the most recent 5 entries from
`invoice.history` concatenated across all records, sorted by `at` desc.

### Implementation pieces

- New `<section id="view-home" hidden>` in `index.html` after the
  topbar, before `view-invoice`.
- `routeView()` adds `onHome = hash.startsWith('/home')` branch; hides
  all other views.
- New `renderHomePage()` in `app.js` — computes hero stats from
  `invoices`, renders the tile grid (static markup) and the activity
  list. Wire it from `routeView()`.
- Each tile is a `<button class="home-tile" onclick="...">` calling
  `startNewInvoice() + goToInvoice()`, `openInvoices()`,
  `openCustomers()`, `openCompanies()`, `openFinancial()`,
  `openSettings()` respectively.
- New entry points: `openHome()` (`location.hash = '#/home'`) and add
  `home` to the topbar nav handler list.

### Styling

Reuse existing card patterns (`.settings-card`, `.invoice-row`) — no
new design tokens. New rules:

```css
.home-page { max-width: 1100px; margin: 0 auto; padding: 24px; }
.home-hero { ... }                  /* big card with stat line */
.home-tile-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
@media (max-width: 780px) { .home-tile-grid { grid-template-columns: 1fr; } }
.home-tile { padding: 24px; text-align: left; ... }
.home-tile h3, .home-tile p { ... }
.home-activity-list { ... }
```

Match the dark + light theme variables already in use.

### Acceptance

- Visiting `/` (or `#/`) lands on the home page, not the editor.
- Each tile navigates to its target view and the topbar nav highlights
  the matching item.
- Hero stat line matches a manual count of the invoices list.
- Recent activity reflects the last 5 entries across all invoice
  history blocks.

---

## Part C — Customers page (`#/customers`)

The current `view-customer` page is a **detail** view for one customer
(triggered from list groups by clicking a customer name). There is no
**list** view today — customers only surface as autocomplete in the
editor and as groups inside the invoices list.

### List view

Route: `#/customers`. Markup as a new `<section id="view-customers">`.

Columns: name, email/phone, **total invoiced**, **outstanding**, **last
invoice date**, status mix (small inline counts: 2 paid · 1 issued).

```
┌──────────────────────────────────────────────────────────┐
│  Customers (12)                  [Search ___]  [+ New]   │
├──────────────────────────────────────────────────────────┤
│  Acme Co.                $12,400  $3,200 due   2026-05-24│
│   acme@example.com       7 paid · 2 issued · 1 overdue   │
├──────────────────────────────────────────────────────────┤
│  Beta Ltd.                $4,500     $0 due   2026-04-12 │
│   ...                                                    │
└──────────────────────────────────────────────────────────┘
```

Click row → navigate to `#/customers/<id>` (existing detail view,
which already exists and works).

### Detail view (already exists)

The existing `view-customer` page at
[index.html:497](../index.html#L497) is correct in shape — keep as is,
but:

- Add a `+ New invoice for this customer` button to the header. Clicks:
  `startNewInvoice()` → pre-fill `b-name`, `b-addr`, `b-phone`,
  `b-email`, `b-net-terms` from the customer record → `goToInvoice()`.
- Add an "Edit customer" button that opens an inline edit form (reuse
  the same combo inputs the editor uses). On save, calls the existing
  `saveCustomer()` pathway with the right `selCustId`.
- Add "Delete customer" that gates on outstanding invoices — refuse if
  the customer has any non-paid, non-void invoices.

### New invoice from customer detail

`startNewInvoiceForCustomer(customerId)`:
```js
async function startNewInvoiceForCustomer(customerId) {
  await startNewInvoice();
  const c = customers.find(x => x.id === customerId);
  if (!c) return;
  document.getElementById('b-name').value  = c.name || '';
  document.getElementById('b-addr').value  = c.address || '';
  document.getElementById('b-phone').value = c.phone || '';
  document.getElementById('b-email').value = c.email || '';
  document.getElementById('b-net-terms').value = c.net_terms_days ?? 30;
  selCustId = customerId;
  recalc();
  goToInvoice();
}
```

### Acceptance

- `#/customers` shows every customer with the four numeric columns
  matching a manual sum across `invoices[]`.
- Click row → opens detail page with that customer's invoices
  (functionality already verified).
- "+ New invoice" on detail page lands in the editor with all buyer
  fields pre-filled.

---

## Part D — Companies page (`#/companies`)

Companies are currently buried in Settings → Companies. Promote them.

### What this is NOT

This is **not** moving the companies management out of settings — keep
the Settings → Companies card as is for "edit profile" depth. The new
page is a **business-intelligence** view: how many invoices have I
issued from each seller profile, totalling what?

### Route + list view

Route: `#/companies`. Columns: name, email/phone, **invoices issued**
(count), **total billed**, **outstanding (across customers)**, **last
issued**.

```
┌──────────────────────────────────────────────────────────┐
│  Companies (3)                                            │
├──────────────────────────────────────────────────────────┤
│  Amro Consulting       42 invoices  $61,200  $4,800 due  │
│   billing@amro.co                          last 2026-05-25│
├──────────────────────────────────────────────────────────┤
│  ...                                                      │
└──────────────────────────────────────────────────────────┘
```

Click row → `#/companies/<id>` detail view.

### Detail view (new)

Same shape as the customer detail page but pivoted by company:

- Header with company name + contact info.
- Stats card: total billed from this company, outstanding, paid count,
  average days to pay (when paid_at and date both present).
- Invoice list filtered to invoices where `payload.seller.name`
  matches the company name (the invoice records don't have a
  `company_id` foreign key today — see "Schema follow-up" below).

### Schema follow-up (NEEDED but small)

Invoices store seller data as a free `jsonb` blob — there's no
`seller_company_id` foreign key. To pivot reliably, add one.

New migration `2026-05-XX-invoice-company-link.sql`:

```sql
alter table public.invoices
  add column if not exists company_id uuid
  references public.companies(id) on delete set null;

create index if not exists invoices_company_idx
  on public.invoices (company_id);
```

Client changes:
- `buildInvoiceRecordFromForm` populates `company_id` from `selCompId`.
- `saveInvoice` includes it.
- `pipelineInvoicesForCompany(companyId)` filters by it.
- **Backfill is optional**: existing invoices have `company_id = null`
  and fall back to matching by `payload.seller.name` for display. Do
  not write a migration that backfills automatically — the name match
  is fuzzy and can cross-link. Let users re-issue to associate.

### Acceptance

- `#/companies` shows every company with totals correct against the
  in-memory list.
- Detail page shows invoices issued *from* this company, separate
  from the Settings → Companies editor.
- New invoices issued after the schema migration land with
  `company_id` set; old ones still show via the name fallback.

---

## Part E — Financial dashboard (`#/financial`)

### Scope

Single-page snapshot of the workspace's financial state. No charts —
big numbers + tables. Use the existing card chrome.

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Financial overview                  Period: [This year ▾]  │
├─────────────────────────────────────────────────────────────┤
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐│
│  │ Total      │ │ Paid       │ │ Outstanding│ │ Overdue    ││
│  │ $124,500   │ │ $98,100    │ │ $26,400    │ │  $4,800    ││
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘│
├─────────────────────────────────────────────────────────────┤
│  Monthly breakdown                                          │
│   Jan  $8,200 paid · $1,200 outstanding                     │
│   Feb  $11,400 paid · $0                                    │
│   ...                                                       │
├─────────────────────────────────────────────────────────────┤
│  Top customers (this period)                                │
│   1. Acme Co.        $42,100  (14 invoices)                 │
│   2. Beta Ltd.       $18,400  (9 invoices)                  │
│   ...                                                       │
├─────────────────────────────────────────────────────────────┤
│  By currency                                                │
│   USD  $110,200 (78 invoices)                               │
│   LBP  ₺850,000  (4 invoices)                               │
└─────────────────────────────────────────────────────────────┘
```

### Period selector

Top-right `<select>`. Options:
- This month
- Last month
- This quarter
- This year (default)
- All time
- Custom range (two date inputs that appear when chosen)

All computation is client-side from the in-memory `invoices` list.
Filter `inv.date` against the period bounds.

### Number contracts

- **Total** = sum of `inv.total` for non-voided invoices in period.
- **Paid** = sum of `inv.total` where `status === 'paid'`.
- **Outstanding** = sum where `effectiveStatus` is `issued` or
  `overdue`.
- **Overdue** = sum where `effectiveStatus === 'overdue'`.

These must be **per currency** under the hood — a USD total + an LBP
total should not be summed numerically. Render each currency in its
own row in the "Total" tile when more than one is present:

```
┌────────────┐
│ Total      │
│ $124,500   │
│ ₺ 850,000  │
└────────────┘
```

The single-row form is correct when only one currency is in use.

### Implementation pieces

- New `<section id="view-financial">` in `index.html`.
- `routeView()` branch for `#/financial`.
- New helpers in `app.js`:
  - `getFinancialPeriod()` → `{from, to}` based on the selector.
  - `summarizeInvoices(period)` → totals grouped by currency.
  - `monthlyBreakdown(invoices, period)` → array of
    `{monthLabel, paidByCurrency, outstandingByCurrency}`.
  - `topCustomersByRevenue(invoices, period, n=10)`.
- New `renderFinancialPage()` ties it all together.
- Persist the selected period in `localStorage` so it sticks across
  page reloads.

### Styling

- Reuse the customer-stat card pattern from
  [app.css customer-stat](../app.css#L1) (search for `.customer-stat`).
- New container `.financial-tiles` for the top stat grid.
- New `.financial-monthly` table.

### Acceptance

- The four tiles match manual sums against the invoice list, per
  currency.
- Changing the period selector re-renders without a page reload.
- Top customers list matches a manual sort of revenue by buyer name.
- Voided invoices are excluded from all totals.

---

## Part F — Navigation overhaul

### Top bar

Current top-bar nav: Editor, Invoices, Settings. New shape:

```
[Logo]  Home  Editor  Invoices  Customers  Companies  Financial  Settings   [Auth]  [SignOut]  [#counter]
```

That's 7 items — fine on desktop, overflows on mobile. On mobile,
collapse everything except Home + Editor + a hamburger that opens a
drawer with the rest.

### Mobile drawer

- New icon button (hamburger) on the topbar, mobile-only.
- Opens a slide-down drawer listing the routes with icons.
- Closes on selection or on tap outside.
- Markup: `<nav class="mobile-nav-drawer">…</nav>` after the topbar.

### Active route highlighting

Existing `routeView()` already toggles `.active` on
`.topbar-nav .nav-link`. Extend to handle the new routes — drive off a
single `currentRoute` variable rather than per-branch `if (onSettings)`.

```js
function currentRouteName() {
  const h = location.hash || '';
  if (h.startsWith('#/home'))      return 'home';
  if (h.startsWith('#/customers')) return 'customers';
  if (h.startsWith('#/companies')) return 'companies';
  if (h.startsWith('#/financial')) return 'financial';
  if (h.startsWith('#/invoices'))  return 'invoices';
  if (h.startsWith('#/settings'))  return 'settings';
  return 'editor';
}
```

Use it for active highlighting and to decide which `view-*` element to
unhide.

### Removed assumption

The Editor stops being the default landing. Anyone who bookmarked `/`
will land on Home — that's the intent. The "[← Editor]" back buttons on
sub-pages should point to wherever the user came from (Home if hash was
`#/`, the previous route otherwise). Track this with a simple
`window.history.length` heuristic, or just always go to Home as the
back target since the user can hit Editor in the nav.

### Acceptance

- All 7 routes accessible from desktop top bar.
- Mobile drawer opens, closes, and routes correctly.
- Active highlighting matches the visible route on every navigation.
- Back buttons from sub-pages return to Home (not Editor), unless
  the user explicitly came from Editor.

---

## Implementation sequence

Each part lands as its own commit; sequence matters because later
parts depend on earlier infrastructure.

1. **Part A — number/banner sync fix.** ~30 minutes. Ships
   independently, no UI changes.
2. **Part F — navigation refactor.** ~1 hour. Foundation for all new
   routes. After this lands, `#/home`, `#/customers`, `#/companies`,
   `#/financial` resolve to placeholder empty views — that's fine.
3. **Part B — Home page.** ~1.5 hours.
4. **Part C — Customers page (list + detail polish).** ~1.5 hours.
5. **Part D — Companies page + schema migration.** ~2 hours
   (the migration file is small; most time is the pivot helpers).
6. **Part E — Financial dashboard.** ~2 hours (period selector logic
   + per-currency aggregation are the bulk).

Total: ~8 hours. Each part is independently reviewable and shippable.

---

## Migrations the user runs

This round adds one new migration file:
- `supabase/migrations/2026-05-XX-invoice-company-link.sql` (Part D).

(Plus the existing
`supabase/migrations/2026-05-29-invoice-void-status.sql` from the
previous round, if not yet run.)

Apply both in the Supabase SQL editor, in date order, after the new
code is deployed.

---

## Out-of-scope cleanups noticed (do NOT touch in this round)

- The `companies` Settings card could be slimmed once Part D's
  Companies page exists — but keep the deep editor in Settings for
  this round; collapse later.
- `selCompId` is used as a global to track the editor's current
  company; once invoices have `company_id`, the editor binding logic
  could be tightened. Defer.
- The home page's "Recent activity" could be its own endpoint when
  invoice history grows — for now, in-memory is fine.

---

## Acceptance criteria (whole round)

1. Loading `/` shows the Home page.
2. All six routes (Home, Editor, Invoices, Customers, Companies,
   Financial, Settings) reachable from the top bar; mobile drawer
   works.
3. Home page hero numbers match a manual count.
4. Customers page lists every customer with correct totals; clicking
   a row opens the existing detail page.
5. Companies page lists every company with correct totals; clicking
   a row opens a new detail page filtered to that company's invoices.
6. Financial dashboard's four tiles + monthly + top-customer + by-
   currency sections all reconcile against manual sums.
7. Editing an existing invoice and changing its number no longer
   shows the banner/number desync from the recent screenshot.

---

*Brief written 2026-05-29. Update inline as items land.*
