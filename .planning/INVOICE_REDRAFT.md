# Plan — Invoice issuing redraft

Working brief for the next implementer. This is the third pass on the
invoice flow — the previous two (`INVOICE_EDITOR_OVERHAUL.md`,
`APP_RESTRUCTURE.md`) tried to make a single shared editor behave
correctly across "new", "editing draft", and "editing issued" modes.
That model is the root of the recurring bugs (banner/number desync,
new invoice inherits last one, status getting stuck). This round
replaces the model.

## The diagnosis (why the previous fixes keep leaking)

The editor today is a **single DOM form** whose meaning depends on
two globals (`editor.mode`, `editor.invoiceId`) and one localStorage
slot (`inv_draft_v1`). The same `<input id="inv-num">` is, depending
on those globals:
- a guess at the next number (mode=new, no draft),
- the number a user wants to issue under (mode=new, with draft),
- the immutable identifier of an already-issued record (mode=editing).

Every bug we've shipped against is a different combination of those
three meanings drifting out of sync. The defensive `reconcileEditorBinding`
helper is a smoke alarm, not a foundation.

## The redraft, in one sentence

**A draft is a separate object from an issued invoice; the editor only
ever edits drafts; an issued invoice has its own URL and is read-only
by default.**

---

## New data model

Two kinds of records:

### Drafts (client-side, ephemeral)

Stored in localStorage under `inv_drafts_v2`, keyed by a client-side
UUID. Each draft is a complete `collectData()` blob **plus** a `local_id`.

```js
{
  local_id: 'd_abcd1234',
  created_at: ISO,
  updated_at: ISO,
  // …full payload (buyer, seller, items, notes, dates, etc.)
  // notably: NO invoice number until issuance.
}
```

Multiple drafts can coexist. A draft has no invoice number and never
hits the server. When the user clicks "Issue", the draft is
serialized into a real invoice record (with a number assigned on the
spot) and the draft entry is deleted.

### Invoices (server-side, immutable identity)

A row in `public.invoices`. Once written, its `id`, `number`, `date`,
`buyer`, `seller`, and `payload` are stable. Only `status`, `paid_at`,
`sent_at`, `history` are mutated post-issuance. Editing is allowed
but goes through an **explicit re-issue path** (see below).

The `payload` column keeps a snapshot of the canonical form data so
the renderer is the same code path as drafts.

### What goes away

- `inv_draft_v1` (the single overloaded slot).
- `editor.mode`, `editor.invoiceId`, `editor.boundNumber`,
  `editor.dirty`, `setEditorMode`, `reconcileEditorBinding`.
- `editingInvoiceId` (already gone but mentally still present).
- The `applyPayloadToForm` round-trip through `DRAFT_KEY`.
- The `setInvoiceNumber → maybe break binding` side-effect.
- Auto-advance of the number after Generate.
- Auto-issue toggle (status changes are explicit now).

The simplification is significant: no shared mutable state means no
desync.

---

## New routes

| URL | Purpose |
|---|---|
| `#/home` | Landing (unchanged) |
| `#/drafts` | List of unsent drafts (replaces "Editor" tab) |
| `#/drafts/<local_id>` | Edit one draft |
| `#/invoices` | List of issued invoices (unchanged) |
| `#/invoices/<id>` | View one issued invoice (read-only) |
| `#/invoices/<id>/edit` | Edit an issued invoice (explicit, requires confirmation) |
| `#/customers`, `#/customers/<id>`, `#/companies`, `#/companies/<id>`, `#/financial`, `#/settings` | Unchanged |

The "Editor" topbar item is renamed **"Drafts"** and points to
`#/drafts`. The `+ New invoice` action everywhere creates a fresh
draft and navigates to `#/drafts/<new_local_id>`.

`#/editor` is kept as a permanent redirect to `#/drafts` for old
bookmarks.

---

## Invoice lifecycle, end to end

```
                    ┌──────────────────────────────────────┐
                    │  + New invoice (from anywhere)       │
                    │  → creates draft, navigates to it    │
                    └─────────────────┬────────────────────┘
                                      │
                  edit fields ────────▼─────── autosave to localStorage
                                      │           (no number yet)
                                      │
                  ┌──────────────┬────┴────┬───────────────┐
                  │              │         │               │
                  ▼              ▼         ▼               ▼
              Discard         Save as   Issue        Issue + Send
              (delete         draft     (PDF +       (PDF + email,
               draft)         (no-op    save row,    later milestone)
                              just      assign #,
                              navigate  delete
                              away)     draft)
                                          │
                                          ▼
                                   #/invoices/<id>   (read-only)
                                          │
                                ┌─────────┼─────────┐
                                │         │         │
                                ▼         ▼         ▼
                           Mark paid    Void   Edit (new draft
                                                copy + supersede)
```

### Issuance (the only place a number is assigned)

1. User on `#/drafts/<id>` clicks **Issue**.
2. Confirm dialog: "Issue INV-2026-NNN to <buyer.name>?" — number
   shown is `computeNextInvoiceNumber()`, computed at click time
   against the current `invoices` list.
3. Render PDF (current path).
4. Insert into `public.invoices` with that number, status='issued',
   `sent_at = now`.
5. Delete the draft from localStorage.
6. Navigate to `#/invoices/<id>` (read-only detail view).
7. Toast: "INV-2026-NNN issued."

No number is ever stored in a draft. No number is ever advanced
client-side. The first writer wins on the supabase unique constraint
(see "Schema" below).

### Editing an already-issued invoice

Per global rule "Server-Authoritative Derived Data" and to keep the
audit trail clean:

1. User on `#/invoices/<id>` clicks **Edit**.
2. Confirm: "Editing an issued invoice supersedes the original. The
   old invoice will be voided and replaced. Continue?"
3. App creates a new draft cloned from the invoice's payload (still
   no number assigned). Routes to `#/drafts/<new_local_id>`.
4. User edits, clicks Issue → new invoice row inserted with a fresh
   number. Original is patched to `status='void'` with a `superseded_by`
   pointer.
5. The voided original stays in the list (visible only via the "Show
   voided" toggle) for the audit trail.

This replaces the silent in-place patch the current code does. No
more "I edited an issued invoice and lost the original."

### Light edits (status only)

`Mark paid`, `Unpay`, `Mark void` directly patch the record in place
— no draft, no new number. These are the only post-issuance writes
that don't supersede.

---

## State model (what replaces `editor.*`)

```js
// One object per OPEN draft. Multiple drafts can coexist in storage.
let drafts = {};          // { [local_id]: DraftRecord }

// Which draft is currently in the editor (null when not on a draft route).
let editingDraftId = null;

// Which invoice is shown read-only (null when not on an invoice detail).
let viewingInvoiceId = null;
```

No `mode`, no `boundNumber`, no `dirty`. The route IS the mode:
- `#/drafts/<id>` → editor is showing draft `<id>`, autosave on every keystroke.
- `#/invoices/<id>` → invoice detail page, read-only. The same DOM may
  be reused for rendering but inputs are `disabled` and there's no
  Issue / autosave wiring.

### Draft storage helpers

```js
function loadDrafts()              { /* read inv_drafts_v2 → drafts map */ }
function saveDraft(local_id, data) { drafts[local_id] = data; persistDrafts(); }
function deleteDraft(local_id)     { delete drafts[local_id]; persistDrafts(); }
function persistDrafts()           { localStorage.setItem('inv_drafts_v2', JSON.stringify(drafts)); }
function newDraft(seed = {})       { /* returns {local_id, …seed, created_at, updated_at} */ }
```

`saveDraft` is debounced 350ms (same as today). It writes per-draft,
so opening another draft never clobbers an older one.

### Migration from `inv_draft_v1`

On first boot after deploy: if `inv_draft_v1` exists, parse it,
convert to a single draft under `inv_drafts_v2`, then remove the old
key. Idempotent.

---

## Schema follow-up

One migration file: `supabase/migrations/2026-05-30-invoice-supersede.sql`

```sql
alter table public.invoices
  add column if not exists superseded_by uuid
  references public.invoices(id) on delete set null;

create index if not exists invoices_superseded_by_idx
  on public.invoices (superseded_by);

-- Number uniqueness per user. Prevents two devices from racing to
-- issue the same number. The client retries with `computeNext + 1`
-- on conflict.
create unique index if not exists invoices_user_number_unique
  on public.invoices (user_id, number);
```

The unique constraint is the **single source of authority on
numbers**. Client-side computation is a best-effort UX hint; the DB
is the arbiter. On insert failure with the unique violation, retry
with `computeNext + 1` (max 5 retries, then surface the error).

This also implicitly fixes the dual-counter problem — there's no
counter at all, just the DB and an optimistic client compute.

---

## UI changes

### Drafts list page (`#/drafts`)

New section. Lists every draft in localStorage, newest first. Each
row:
- Buyer name (or "(no buyer yet)").
- Item count + grand total preview.
- "Last edited <relative time>".
- Buttons: **Open**, **Discard**.

Top-right: `+ New draft` button.

If there are zero drafts, render an empty state with a single big
"+ New draft" CTA.

### Editor page (`#/drafts/<id>`)

Same form as today, but:
- **No** "Editing INV-X" banner (drafts have no number).
- **No** "Start new" button in the sidebar (use the back button +
  the drafts list to switch drafts).
- The status section is replaced with an **Issue** card:

```
┌────────────────────────────────────────────────┐
│  Ready to issue                                 │
│  Will be saved as INV-2026-014                  │
│  ┌──────────────────┐  ┌──────────────────────┐ │
│  │ Issue (PDF)      │  │ Issue + email later  │ │  ← future
│  └──────────────────┘  └──────────────────────┘ │
│  ┌──────────────────┐                           │
│  │ Discard draft    │                           │
│  └──────────────────┘                           │
└────────────────────────────────────────────────┘
```

The `INV-2026-014` value is re-computed on every render so it stays
fresh as other devices issue. It is informational only — the actual
number is determined by the DB at insert time.

The Invoice # input field stays in the form but is **read-only,
muted, and labeled "Assigned at issuance"**. Removing it entirely
would break PDF templates that read it; keep but make it visibly
inert.

### Invoice detail page (`#/invoices/<id>`)

New section. Reuses the editor's DOM for rendering the invoice but:
- All `<input>` / `<textarea>` / `<select>` elements set `disabled`.
- The action bar shows status, "Mark paid / Unpay", "Void", "Edit",
  "Duplicate", "Open PDF" buttons.
- A small "Edit" button on the right opens the supersede dialog
  (above).

This is the canonical "view an issued invoice" experience.

### Topbar nav

- "Editor" → renamed **"Drafts"** (`#/drafts`).
- The other items stay (`Home, Drafts, Invoices, Customers,
  Companies, Financial, Settings`).

### Editor side-section cleanup

Remove or hide while on a draft:
- "Invoice status" buttons (status is implicit: drafts are drafts).
- "Editing X / Start new" banner.

Replace with the **Issue** card described above.

---

## Acceptance criteria (the bugs that should be impossible)

1. **Editor on landing.** Hard refresh `/` always shows Home. The
   editor route requires `#/drafts/<id>` or `#/invoices/<id>/edit`;
   there is no global "the editor" state.

2. **Banner / number desync.** Banner is removed. The Invoice # input
   on a draft is read-only with the next number rendered live; on an
   invoice detail it's disabled with the assigned number. There is no
   editable number field anywhere — desync becomes representable only
   as a bug in `computeNextInvoiceNumber`, which is small and pure.

3. **New invoice inherits last one.** "+ New invoice" creates a fresh
   `local_id` and writes a fresh draft. Routes to `#/drafts/<new_id>`.
   The form is hydrated from THAT draft. Switching from another draft
   has no cross-contamination because each draft has its own slot.

4. **Reload survives.** Reload on `#/drafts/<id>` rehydrates from
   `inv_drafts_v2`, finds the right draft by id, applies its payload.
   Reload on `#/invoices/<id>` re-fetches from the invoices list. No
   shared draft slot for issued records.

5. **Two devices issuing simultaneously.** Unique constraint on
   `(user_id, number)` means one wins; the loser retries with
   `next + 1`. No collision, no silent overwrite.

6. **Editing an issued invoice doesn't destroy it.** The "Edit"
   action explicitly creates a supersede draft. Old invoice survives
   as voided with `superseded_by` set.

---

## Implementation order

Each step is independently testable. Land in order; do not bundle.

1. **Schema migration.** Write `2026-05-30-invoice-supersede.sql`,
   pause for the user to run it in the Supabase SQL editor before
   continuing. **Do not deploy code that depends on the new columns
   before the migration runs.**

2. **Draft storage layer.** Implement `loadDrafts`, `newDraft`,
   `saveDraft`, `deleteDraft`, `persistDrafts`. Add the one-shot
   migration from `inv_draft_v1` to `inv_drafts_v2`. Unit-style:
   open the page, make a draft, reload, verify draft survived under
   the new key.

3. **Routes + view sections.** Add `#/drafts` and `#/drafts/<id>` and
   `#/invoices/<id>` (and `…/edit`). Wire `currentRouteName()` and
   `routeView()`. Add a `#/editor` → `#/drafts` redirect so old
   bookmarks work.

4. **Drafts list page.** Render the list from `drafts`. Wire "+ New
   draft", Open, Discard. Empty state.

5. **Editor renders only for drafts.** When `#/drafts/<id>`, load
   that draft into the form (`applyPayloadToForm`). Autosave writes
   back into the draft slot only. Remove all `editor.mode`-aware
   branches from `recalc`, `saveDraft`, `setInvoiceNumber`,
   `generate*`, and the input listener on `#inv-num`. The Invoice #
   field becomes `readonly` with the live `computeNextInvoiceNumber()`
   value injected.

6. **Issue action.** Implement the "Issue" button: confirm dialog →
   generate PDF → insert invoice (retry on unique-constraint
   conflict) → delete draft → navigate to `#/invoices/<id>`.

7. **Invoice detail page.** Render an invoice read-only. Action bar
   with Mark paid / Unpay / Void / Edit / Duplicate / Open PDF.
   Re-use the existing PDF generation for "Open PDF" by passing the
   stored payload (no re-issuance, no number bump).

8. **Edit / supersede flow.** Clicking Edit on an invoice detail
   creates a new draft seeded from the invoice's payload, marks the
   original as `superseded_by` placeholder (only finalized when the
   new one is issued), navigates to the new draft.

9. **Topbar rename.** "Editor" → "Drafts". Hide the legacy "Invoice
   status" sidebar block while in draft mode.

10. **Cleanup.** Remove dead helpers: `setEditorMode`,
    `reconcileEditorBinding`, `editor` global, `editingBoundNumber`
    references in CSS comments, the `inv_draft_v1` constant. Search
    for stragglers and delete them — leftover code is a footgun.

Estimated total: ~10–12 hours of focused work. The first 3 steps
unblock everything else.

---

## What this does NOT change

- The PDF generation pipeline (`/api/generate-pdf`, the renderer)
  stays identical. The payload it receives is the same shape.
- The customers / companies / financial pages from the previous
  round stay as-is.
- The dark/light theme work stays.
- The Supabase auth flow stays.
- Currency, VAT, discounts, year-prefix — all unchanged.
- The PDF templates themselves do not need changes; they read
  `invoice_number` from the payload, which is now populated at
  issuance instead of upfront.

---

## Open questions

These are decisions the implementer should NOT make alone; ping the
user before defaulting:

1. **What happens to localStorage drafts on sign-out?** Wipe them
   (privacy) or keep them (so users don't lose work)? Default
   suggestion: **keep**, but warn at sign-in time that drafts from
   the previous session are still there.

2. **Multi-device drafts.** Sync drafts to Supabase (so I can start
   on phone, finish on laptop)? Out of scope for v1; mention in
   FUTURE_WORK. Default: local-only.

3. **Confirm before issuance, every time?** Or just for amounts above
   a threshold? Default: **every time**, with a "Don't ask for
   amounts under $X" preference later.

4. **Bulk issue from drafts list?** E.g., a user has 5 drafts and
   wants to issue all at once. Default: **no** — issuance is a
   deliberate per-invoice action. Defer to FUTURE_WORK.

---

## Cleanup of leftover bug from this round

The "editor shows on landing" bug should be physically impossible
after this redraft: there is no global editor view anymore.

If the implementer still sees the editor on landing **before** they've
finished the redraft, the cause is one of:
- Vercel build for `adfae13` hasn't finished (check the dashboard).
- Service worker / aggressive browser cache. The site doesn't ship a
  service worker, so Ctrl+Shift+R or DevTools "Disable cache" suffice.
- `index.html` cached at a CDN edge. Wait 60s, retry.

Do not "fix" it again with another defensive guard. The redraft is
the fix.

---

*Brief written 2026-05-30. Update inline as items land.*
