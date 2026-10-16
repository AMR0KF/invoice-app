# App restructure — Jobs, Trucks, Expenses + owner/driver roles

Adds a shared **operations layer** (trucks / jobs / expenses) and **owner/driver
roles** on top of the existing per-user invoicing app. Targeted, additive
changes only — invoice editor, PDF generation, customers, companies, financial,
settings, auth modal, and existing RLS are untouched.

*Implemented 2026-06-17.*

---

## Key decisions (and why)

1. **Workspace-shared RLS for trucks/jobs/expenses** — *the central call.*
   The spec says "same user_id pattern as existing tables," but it also
   requires the **owner to see ALL jobs** (incl. the driver's) and to **issue
   an invoice from a driver-created job**. Strict per-user RLS makes that
   impossible — the owner literally couldn't read the driver's rows. So these
   three tables keep a `user_id` column for **provenance only** (`created_by`),
   and RLS grants every authenticated user full access (`using (true)`).
   Invoices / customers / companies stay per-user (unchanged). There are
   exactly two trusted workspace members (amro, amer), so this is safe.
   → To revert to strict isolation, change the three policies in the migration
     to `using ((select auth.uid()) = user_id)` — but that breaks owner
     oversight, so it's deliberately not the default.

2. **Customer field = native `<select>`**, not the invoice's typeahead combo.
   The editor's combo is hardwired to `b-name`/`s-name` + `cust-dropdown`.
   A `<select>` (value = customer id) is unambiguous for the job→invoice link
   and far less code. Spec intent ("select from customers") is satisfied.

3. **Profile screen is minimal.** The spec only names it in the driver nav
   (Home → Jobs → Profile) without a field list. Built a lightweight page:
   name, role badge, assigned truck, jobs-today, View jobs + Sign out.

4. **Expenses: schema + local routes only, no UI.** The spec adds the expenses
   *entity* but defines no screen. Table, `data/expenses.json`, Flask routes,
   and `loadExpenses()` exist for future use; no expense UI was built.

5. **Client-side job numbering** (`JOB-001`), mirroring `computeNextInvoiceNumber`
   — the loaded list is the single source of truth. No DB sequence.

6. **Status select offers pending/done/cancelled.** Spec form lists
   pending/done; `cancelled` is in the table enum and harmless to expose, and
   gives a way to cancel. List filter chips stay all/pending/done per spec.

---

## Files changed

- `supabase/migrations/2026-06-17-jobs-trucks-expenses.sql` **(NEW — user must run)**
- `supabase/schema.sql` — added trucks/jobs/expenses + `user_settings.role`/
  `assigned_truck_id` + `invoices.job_id` (canonical schema kept complete)
- `data/trucks.json` (NEW, seeds Truck 1/2), `data/jobs.json`, `data/expenses.json` (NEW, `[]`)
- `server.py` — `/api/trucks` (GET, seeds), `/api/jobs` + `/api/expenses` (GET/POST/PATCH/DELETE)
- `index.html` — Jobs + Profile nav links (topbar + drawer); view sections
  `view-jobs`, `view-job-edit`, `view-job-detail`, `view-profile`
- `app.js` — state vars; trucks/jobs/expenses data layer; `loadUserRole`/
  `applyRoleNav`; routing (currentRouteName/routeView/navHighlight/guard);
  render functions; home driver branch + owner "Jobs today" tile; `job_id`
  threaded through issuance
- `app.css` — job cards, type/status badges, job form, role badge, tile badge

---

## Migration the user runs

In the Supabase SQL editor, **after all earlier migrations**:
`supabase/migrations/2026-06-17-jobs-trucks-expenses.sql`

It is idempotent. It creates the tables, adds the columns, sets RLS, seeds
two trucks, and sets `amro=owner`, `amer=driver` with `amer.assigned_truck_id`
= Truck 1. Until it's run, `loadJobs`/`loadUserRole` fail gracefully (role
defaults to owner, jobs fall back to the local cache) so nothing locks up.

---

## Role behaviour

| | Owner (amro) | Driver (amer) |
|---|---|---|
| Nav | Home, Jobs, Drafts, Invoices, Customers, Companies, Financial, Settings | Home, Jobs, Profile |
| Jobs list | all trucks (+ truck filter) | auto-scoped to assigned truck, no toggle |
| Job form truck | free select | pre-filled + locked to assigned truck |
| Create invoice from job | enabled | visible but disabled, tooltip "Requires owner or admin" |
| Owner-only routes | accessible | redirect → `#/jobs` |

`currentUserRole` is read once on login (`loadUserRole`). Local/offline mode
defaults to owner (full access).

---

## Verification done

- `node --check app.js` ✓ · `py_compile server.py` ✓ · JSON valid ✓
- Flask test client: trucks seed; jobs + expenses GET/POST/PATCH/DELETE round-trip ✓
- All 25 new handlers/functions defined exactly once ✓

## Acceptance checklist (manual, post-migration)

- [ ] Owner sees Jobs tab before Invoices; "Jobs today" tile on Home.
- [ ] Driver login → nav shows only Home/Jobs/Profile; owner routes bounce to Jobs.
- [ ] Driver job list shows only assigned-truck jobs; new-job truck is locked.
- [ ] Owner: New job → save → appears in list, newest first; filters by truck/status.
- [ ] Job detail "Create invoice from job" (owner) → editor pre-filled with buyer,
      date, "Ref: JOB-xxx"; on issue, invoice.job_id set + job shows "Invoiced".
- [ ] Driver: "Create invoice from job" disabled with tooltip.
