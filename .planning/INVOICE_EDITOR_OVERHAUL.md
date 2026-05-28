# Plan — Invoice editor overhaul + settings toggle fix

Working brief for the next contributor. Two intertwined problem areas:
1. The editor's "new invoice" logic silently inherits the last invoice and
   can clobber issued records (`B`/`C` failure paths below).
2. Two settings toggles render as bare 46×24px pills with no visible
   labels because the markup nests the label text inside the pill.

Both are landed together because they're the next round of polish before
the email/recurring/payments features in `FUTURE_WORK.md` can be built on
top of a trustworthy data layer.

## Non-goals

- Email-the-invoice (`FUTURE_WORK.md` #7).
- Recurring invoices (`FUTURE_WORK.md` #8).
- Stripe / payment links.
- Activity dashboard card.
- Customer-side fuzzy autocomplete.

These are documented but explicitly out of this round.

---

## Part A — Editor state model overhaul

### The bug, in one paragraph

The editor mixes **three concepts** under one localStorage key
(`inv_draft_v1`, the `DRAFT_KEY` constant) and two globals
(`editingInvoiceId`, `editingBoundNumber`):

1. Editor state (what's in the form right now).
2. Unsaved-draft persistence (survive reload).
3. Loaded-record payload (hydrate from a saved invoice).

[app.js:2361](../app.js#L2361) — `loadInvoiceIntoEditor()` reuses
`DRAFT_KEY` as the "apply payload to form" channel
(`localStorage.setItem(DRAFT_KEY, …); restoreDraft();`). This single
design choice produces every editor bug below.

### Failure paths to fix (with repro)

**A. Reload while editing a saved invoice ⇒ "new" form silently inherits the old one.**
[app.js:2370](../app.js#L2370) writes the saved payload into `DRAFT_KEY`.
On reload, [app.js:34](../app.js#L34) `restoreDraft()` rehydrates the
form, but `editingInvoiceId` is a JS global — it's gone. Banner hides,
form looks like a "new" invoice, Generate creates a duplicate of INV-067
instead of patching it.

**B. User types in the # field ⇒ stale binding, screenshot bug.**
[app.js:894-908](../app.js#L894-L908) `setInvoiceNumber` breaks the
binding when the *programmatic* number doesn't match `editingBoundNumber`.
User typing into `#inv-num` is a plain `input` event — never goes through
`setInvoiceNumber`, so the binding never breaks. Repro: open INV-067 →
type `INV-069` in the number field → banner still says "EDITING INV-067"
→ click Generate → **INV-067 gets patched in place with INV-069's data**.
Silent data loss.

**C. Editing a saved invoice ⇒ edits clobber the draft slot.**
[app.js:1734](../app.js#L1734) — every keystroke writes the current form
into `DRAFT_KEY`. After a reload (path A), restoreDraft pulls the
*edited* fields into a "new" form. The user's edits never land on the
saved record; the original record stays stale on the server.

**D. Dual counters drift.**
Two sources of truth for the next invoice number: the server's
`inv_next_number` (Flask `/api/invoice-number`) and the actual
`invoices` table. Generated invoices in Supabase don't bump the Flask
counter. [app.js:880](../app.js#L880) prefers the localStorage cache,
which is per-device. After a fresh device sees N existing invoices but
a stale counter, the next number is wrong and can collide with B above.

**F. Auto-issue + status workflow is one-way.**
[app.js:1284](../app.js#L1284) — generating a PDF auto-flips draft→issued.
There is no "revert to draft" path; user has to set status manually.
Acceptable, but make it explicit in the UI (toast says "Marked issued —
click Draft to revert").

**G. Hard delete on issued invoices.**
[app.js:2487](../app.js#L2487) `deleteCurrentInvoice()` and bulk-delete
fully remove records with no audit trail. Replace with a `void` status
on issued+ invoices; reserve hard delete for drafts.

### Target model

#### Single editor state object

Replace the two-global ad-hoc state with one object:

```js
let editor = {
  mode: 'new',           // 'new' | 'editing'
  invoiceId: null,       // set iff mode === 'editing'
  boundNumber: null,     // set iff mode === 'editing'
  dirty: false,          // for editing mode — toggles Save button enabled
};
```

`mode` is the source of truth. Every code path reads `editor.mode`; no
implicit `if (editingInvoiceId)` checks.

Provide a tiny accessor module (top of `app.js`, near the existing state
block):

```js
function setEditorMode(mode, inv = null) {
  editor.mode = mode;
  editor.invoiceId   = mode === 'editing' ? inv?.id   : null;
  editor.boundNumber = mode === 'editing' ? inv?.number : null;
  editor.dirty = false;
  renderEditingBanner();
  renderSaveButton();
}
```

#### Two persistence slots, never overloaded

- `inv_draft_v1` — used **only** when `mode === 'new'`. The "unsaved
  draft" lifecycle.
- Saved invoices — server (Supabase `invoices`) or local JSON. Editing
  a saved invoice does NOT write to `inv_draft_v1`.

#### Two distinct entry points to the form

- `applyPayloadToForm(payload)` — pure DOM hydration. No localStorage
  side effects. Extracted from the body of `restoreDraft()` at
  [app.js:1744](../app.js#L1744).
- `restoreDraft()` becomes a thin wrapper:
  `const d = readDraft(); if (d) applyPayloadToForm(d); return !!d;`
- `loadInvoiceIntoEditor(inv)` calls `applyPayloadToForm(inv.payload)`
  directly — drop the round trip through `DRAFT_KEY` at
  [app.js:2370](../app.js#L2370).
- `unbindEditor()` (`= startNewInvoice` rewrite) — set `mode = 'new'`,
  `applyPayloadToForm(blankPayload())`, compute next number from the
  invoices list, hide banner, clear draft.
- `bindEditor(inv)` (`= loadInvoiceIntoEditor` rewrite) — set
  `mode = 'editing'`, set ids, `applyPayloadToForm(inv.payload)`, render
  banner.

#### Number-field input listener (the screenshot bug)

Wire an `input` listener on `#inv-num` that calls a new
`maybeBreakBinding()`:

```js
document.getElementById('inv-num').addEventListener('input', (e) => {
  if (editor.mode !== 'editing') return;
  if (e.target.value.trim() !== editor.boundNumber) {
    setEditorMode('new');
    toast('Number changed — this will save as a new invoice', 'info');
  }
});
```

Same check that `setInvoiceNumber` already does at
[app.js:904](../app.js#L904) — applied to user input as well.

#### Autosave gated on mode

[app.js:1723](../app.js#L1723) `saveDraft()` adds a guard at the top:

```js
function saveDraft() {
  if (_draftRestoring) return;
  if (editor.mode !== 'new') return;   // NEW: don't pollute draft slot while editing a saved record
  // …existing body
}
```

For editing mode, accumulate edits in memory and flip
`editor.dirty = true`. Surface a "Save changes" button in the editing
banner — enabled only when dirty. Clicking it calls
`patchInvoice(editor.invoiceId, …)` with the full payload.

#### Generate semantics split by mode

[app.js:1283](../app.js#L1283) `persistGeneratedInvoice()` already
branches on `editingInvoiceId`. Make the branches behave differently:

- `mode === 'new'`: insert a new record, advance the number, call
  `unbindEditor()` → editor returns to a clean "new" state with the
  next number ready. Current behaviour, but explicit.
- `mode === 'editing'`: patch the bound record, **do not** advance the
  number, **do not** clear the form. Stay in editing mode. Toast:
  `"Saved changes to INV-067"`.

Today the same code path runs for both; the number always advances and
the form looks "weirdly cleared" after re-generating an existing invoice.

#### Derive the next number from the list

`next_invoice_number = max(parseNumber(inv.number) for inv in invoices) + 1`
(per year if year-prefix is on). New helper `computeNextInvoiceNumber()`
in `app.js`. Replace [app.js:880](../app.js#L880) `loadInvoiceNumber()`'s
body with a single call to this helper. The Flask
`/api/invoice-number` endpoint becomes a thin computed-from-the-table
wrapper; remove the `data/next_invoice_number.json` file (or whatever
the server uses).

#### Status workflow: add `void`, restrict hard delete

- Add `'void'` to the status enum in
  [supabase/migrations/2026-05-28-invoices.sql](../supabase/migrations/2026-05-28-invoices.sql).
  Write a new migration `2026-05-XX-invoice-void-status.sql` that
  `alter type` / drops + recreates the CHECK constraint to include
  `'void'`. **Use a migration file, not raw SQL via psql/MCP.**
- `deleteCurrentInvoice()` and `deleteInvoiceFromList()` and
  `bulkDelete()`: if any selected record's status is `issued` or `paid`,
  patch to `void` instead of deleting. Drafts may still be hard-deleted.
- Render `void` in the list with a muted strikethrough. Don't include
  void in the default "all" filter; add a "Show voided" toggle on the
  list toolbar.

#### Reload safety

On boot:
- If `inv_draft_v1` exists → restore as a `mode === 'new'` draft
  (current behaviour, but only for true drafts).
- Never auto-rebind to a saved record on reload. The "Editing INV-067"
  banner is session-scope state.
- If the restored draft was actually a saved-record payload that got
  written by the OLD code path (back-compat for users mid-migration),
  detect this via the presence of a `status` field that's not `draft`
  and silently discard the draft instead of restoring it. One-shot
  migration handling.

### Implementation order (Part A)

Each step is independently shippable; sequence matters for safety.

1. **State object + accessors.** Introduce `editor` object; refactor all
   reads/writes of `editingInvoiceId` / `editingBoundNumber` to go
   through `setEditorMode()` and `editor.mode` checks. Mechanical, no
   behaviour change yet. **Acceptance:** all existing flows still work,
   `grep editingInvoiceId app.js` returns only the inside of
   `setEditorMode`.
2. **`applyPayloadToForm` extracted.** Pull the body of `restoreDraft`
   into a pure function. Rewrite `loadInvoiceIntoEditor` to call it
   directly. **Acceptance:** fixes paths A & C above. Manual repro:
   open INV-067 → reload → form is empty (does NOT silently inherit).
3. **Number-field input listener.** **Acceptance:** fixes path B
   (screenshot). Manual repro: open INV-067 → change number to INV-099
   → banner hides on the first keystroke that diverges → Generate
   creates a new INV-099 record, INV-067 stays untouched.
4. **Autosave gated on mode + Save button in editing banner.**
   **Acceptance:** edits to a saved invoice never write to `inv_draft_v1`;
   Save button enabled only when dirty; clicking it patches the record.
5. **Derive next number from the invoices list.** **Acceptance:** fresh
   device with N existing invoices computes the right next number
   without consulting any counter file.
6. **Generate split by mode (insert vs. patch).** **Acceptance:**
   generating from editing mode does not advance the number and keeps
   the form bound; toast says "Saved changes".
7. **Add `void` status; restrict hard delete to drafts.**
   **Acceptance:** issued/paid invoices can't be hard-deleted; voided
   invoices show in a dedicated filter.

---

## Part B — Settings toggles render as label-less pills

### The bug

In `index.html` the two toggles at lines ~582 and ~592 use this markup:

```html
<div class="settings-toggle">
  <label class="switch-control" for="settings-year-prefix">
    <input type="checkbox" id="settings-year-prefix" onchange="toggleYearPrefix()">
    <span class="switch-track" aria-hidden="true"></span>
    <span class="switch-meta">
      <strong>Year-prefixed numbers</strong>
      <small>Use <code>INV-YYYY-001</code> and reset to 001 on Jan 1.</small>
    </span>
  </label>
</div>
```

[app.css:1125-1162](../app.css#L1125-L1162) defines `.switch-control` as
`width: 46px; height: 24px; position: relative;` and `.switch-track` as
`position: absolute; inset: 0;` — a fixed pill with the track absolutely
covering its entire box. The `<span class="switch-meta">` containing
the strong+small labels is rendered **inside that 46×24 pill**, behind
the dark `.switch-track` background. There is no CSS rule for
`.switch-meta` (verified with grep), so it inherits nothing useful.
Result: the toggle is the bare pill the user is seeing, with labels
invisible.

The working pattern is `.theme-switch` at [app.css:1114](../app.css#L1114),
which keeps the label markup in a *sibling* `<div>` instead of nesting
it inside `.switch-control`. The settings-year-prefix and
settings-auto-issue toggles diverge from that pattern.

### Fix

Refactor the markup AND add styles. Two changes:

#### B1. Rewrite the markup in `index.html` for both toggles

Use the same shape as `.theme-switch` — label/hint in a sibling, pill in
its own `<label class="switch-control">`:

```html
<div class="settings-toggle">
  <div class="settings-toggle-meta">
    <strong>Year-prefixed numbers</strong>
    <small>Use <code>INV-YYYY-001</code> and reset to 001 on Jan 1.</small>
  </div>
  <label class="switch-control" for="settings-year-prefix">
    <input type="checkbox" id="settings-year-prefix" onchange="toggleYearPrefix()">
    <span class="switch-track" aria-hidden="true"></span>
  </label>
</div>
```

Do this for both:
- `#settings-year-prefix` (index.html ~line 582)
- `#settings-auto-issue` (index.html ~line 592)

Drop the `.switch-meta` span entirely from both.

#### B2. Add `.settings-toggle` + `.settings-toggle-meta` styles

In `app.css`, near the existing `.theme-switch` rule (around line 1114),
add:

```css
.settings-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  grid-column: 1 / -1;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface2);
}
.settings-toggle-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;     /* allow truncation */
}
.settings-toggle-meta strong {
  font-size: 13px;
  color: var(--text);
}
.settings-toggle-meta small {
  font-size: 11.5px;
  color: var(--text3);
  line-height: 1.35;
}
.settings-toggle-meta code {
  background: var(--surface);
  padding: 0 4px;
  border-radius: 3px;
  font-size: 11px;
}
```

The existing `.settings-form-grid .settings-toggle { grid-column: 1 / -1 }`
rule at [app.css:1186](../app.css#L1186) already gives the row full
width — keep that.

#### B3. Verify both light and dark themes

`.settings-toggle` uses `var(--surface2)` and `var(--border)` — both are
theme-aware, so light mode should pick up the correct values. After the
fix, screenshot both themes and confirm the toggles match `.theme-switch`
visually.

### Implementation order (Part B)

1. Edit `index.html` for both toggles (B1).
2. Add the CSS rules (B2).
3. Visual check in dark + light theme (B3).

This is a single ~30-minute change — ship as one commit.

---

## Sequencing the two parts

- **Part B first.** It's a quick visual fix with no data implications.
  Land it independently so the settings page is presentable while Part A
  is in progress.
- **Part A second**, in the 7-step order above. Each step lands as its
  own commit; do not bundle steps because the autosave / number /
  generate changes have user-visible behaviour shifts that need to be
  reviewable in isolation.

---

## Out-of-scope cleanups noticed during audit (do NOT touch in this round)

- The dead `print-preview` API call at [app.js:2135](../app.js#L2135) is
  unreachable after the `return` on the line above. Remove in a separate
  small-cleanup PR.
- `wireDraftAutosave` only wires `input`/`change` to `#view-invoice`,
  which is fine, but the `_draftSaveTimer` is module-scoped and shared
  with restore — a long-running debounce after `clearDraft` could race
  if `clearDraft` is called from a non-saveDraft path. Currently safe
  because both paths clear the timer, but worth a comment.
- The Supabase migration in
  [supabase/migrations/2026-05-28-invoices.sql](../supabase/migrations/2026-05-28-invoices.sql)
  is solid; the `void` status (Part A step 7) needs a follow-up
  migration, not a modification of the existing one.

---

## Acceptance criteria (whole round)

A. Open INV-067 → reload page → form is empty / restored to the previous
   true draft (not to INV-067's content).

B. Open INV-067 → type a different number → banner hides → Generate
   creates a new record, INV-067 stays untouched on the server.

C. Open INV-067 → edit any field → close tab → reopen app → form does
   NOT come back with the unsaved INV-067 edits. (Either: edits were
   saved to the server via the Save button, or they're lost — but they
   never silently move to a "new" draft.)

D. Fresh device, signed in to Supabase, runs the editor: next invoice
   number matches `max(existing) + 1` without any counter file.

E. Generating from editing mode patches the record, keeps the form
   bound, does NOT advance the number; toast confirms.

F. Hard-deleting an issued/paid invoice is impossible — only `void` is
   offered. Drafts can still be hard-deleted.

G. The two settings toggles render with their labels and hints visible,
   matching the `.theme-switch` style in both dark and light themes.

---

*Brief written 2026-05-28. Update inline as items land.*
