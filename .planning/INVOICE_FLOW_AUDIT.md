# Invoice Draft → Issue → Save → PDF: Audit, Findings, and Target Architecture

> Multi-agent audit, 2026-06-03. 6 slices mapped, 20 findings raised,
> 14 confirmed by adversarial verification. Source of truth for the
> invoice-flow fix work.

## 1. How the flow works today (current-state audit)

### 1.1 The live path (`issueDraft`)
The only reachable "Save & Print" path is `issueDraft()` (app.js:2442),
wired to `#issue-btn` (index.html:349, desktop) and `#mobile-issue-btn`
(index.html:448, mobile).

1. Guard: require `editingDraftId`, buyer name, ≥1 line item (app.js:2443-2451).
2. `previewNumber = computeNextInvoiceNumber()` (app.js:2453) — in-memory max+1.
3. Blocking `confirm()` (app.js:2455) — before any button disable.
4. Disable/relabel `#issue-btn` only (app.js:2459-2461).
5. `pdfInfo = await renderPdfForData(data)` (app.js:2469) — PDF first.
6. Retry loop ≤5 (app.js:2480): `buildIssueRecord` → `insertInvoiceRow`. On 23505 only, reload + recompute + retry. PDF rendered once, never re-rendered.
7. Supersede: best-effort `patchInvoice(...void...)` try/catch-toast (app.js:2501-2508).
8. Unconditional `deleteDraftV2`, `setLastGeneratedPdf`, `window.open`, `openInvoiceDetail` (app.js:2510-2525).
9. `finally` re-enables `#issue-btn` only (app.js:2528-2529).

### 1.2 PDF rendering
`renderPdfForData` → `requestPdfGeneration` (app.js:3131) POSTs to
`/api/generate-pdf` then `/api/generate` with a **bare fetch, no
AbortController** (app.js:3138-3142). Server number fields are discarded
(app.js:2648-2650).
- Production (Vercel): `api/generate-pdf.js` honors the sent number, streams PDF.
- Local (server.py): **overrides** `data["invoice_number"]` with its own
  file counter and advances it (server.py:558-559, 574-575).
- Both run `generate_pdf.js` → `page.setContent(html,{waitUntil:"networkidle0"})`
  (generate_pdf.js:856) depending on remote Google Fonts (140-143).

### 1.3 Persistence & lists
`insertInvoiceRow` (app.js:2569): Supabase insert, rethrow 23505 for retry,
optimistic `invoices.unshift`. Non-Supabase short-circuits to `saveInvoice`
(no uniqueness). All list/detail/rollup renders read the in-memory `invoices`.

### 1.4 Drafts v2 lifecycle
`drafts={}` keyed by `local_id` → `inv_drafts_v2`. `bindEditorToDraft`
(app.js:2324) sets `editingDraftId`, `resetEditorForm()` (nulls
`selCustId/selCompId`, app.js:3663-3664), then `applyPayloadToForm(d)`.
Seed callers stash `customer_id/company_id/supersedes` on the draft record.

### 1.5 Legacy v1 overlap (not removed)
`editor` global + `setEditorMode`, `generatePdfFile`→`persistGeneratedInvoice`
→`saveInvoice`, editing banner, `loadInvoiceIntoEditor`, `saveDraft()`/
`inv_draft_v1`, `loadInvoiceNumber`/`setInvoiceNumber` counter still live.
Most are CSS/`hidden`-gated, but **`shareMobilePdf` (index.html:437) is live**
and can fall through to the legacy persist path.

---

## 2. Confirmed findings by severity

### HIGH

- **H1 — Mobile issue button gives no feedback (THE FREEZE).** `issueDraft`
  toggles only `#issue-btn`; `#mobile-issue-btn` (index.html:448) is never
  referenced in app.js. Mobile tap → button looks inert, re-tappable, for
  the whole render. *Primary cause.*
- **H2 — No client-side timeout/abort on PDF fetch.** `requestPdfGeneration`
  (app.js:3131-3151) bare fetch, no AbortController (cf. `API()` app.js:1046).
  Two sequential unbounded endpoints → await hangs past patience.
- **H3 — Server render stalls on remote fonts (`networkidle0`).**
  generate_pdf.js:856 + remote Google Fonts (140-143, display=block). Slow/
  blocked CDN → Puppeteer 30s default → server.py 500 (571) or 60s → 504 (567).
- **H4 — Issued invoice loses customer_id/company_id link.** `buildIssueRecord`
  reads globals `selCustId/selCompId` (app.js:2555-2556), nulled by
  `resetEditorForm` in `bindEditorToDraft`, never restored from
  `d.customer_id/d.company_id`. Draft seeded "for customer X" issued without
  re-selecting → saves `customer_id:null` → vanishes from customer page
  (strict `r.customer_id===customerId` filter, app.js:3891). Company page
  self-heals via seller-name fallback (app.js:4060-4066); customer page does not.
- **H5 — PDF number diverges from saved DB number in local/dev mode.**
  server.py overrides + advances its own counter (558-559, 574); saved row
  uses client `computeNextInvoiceNumber`. PDF and stored record can differ.
  Production unaffected. Retry worsens it (PDF rendered once at 2469, never
  re-rendered when `attemptNumber` changes at 2490).

### MEDIUM

- **M1 — Supersede void best-effort; draft deleted unconditionally.**
  void is try/catch-toast (2502-2508); `deleteDraftV2` runs right after (2510).
  On a real error → `loadInvoices` reverts void → original stays issued,
  replacement live, link missing, draft (only record of intent) gone.
- **M2 — `shareMobilePdf` is a live second persistence system.** PDF-preview
  "Share PDF" (index.html:437) → `shareMobilePdf` (3282); when
  `lastGeneratedPdf` null → `generatePdfFile` → `persistGeneratedInvoice`
  → `saveInvoice` + flips `editor` to editing. Bypasses retry/supersede/draft
  deletion. Double-save / ghost-invoice risk.
- **M3 — Local mode has no number-uniqueness enforcement.** `insertInvoiceRow`
  short-circuits to `saveInvoice` (2570-2573); server.py `create_invoice`
  random id, no check (503-513). 23505 retry only in Supabase branch.
  `computeNextInvoiceNumber` returns INV-001 on empty list (1271-1275).
- **M4 — Optimistic-insert/company-rollup asymmetry.** `OPTIONAL_COLUMNS`
  (2582) has `company_id` but not `customer_id`. Company self-heals via
  name match; customer (strict id) cannot. Compounds H4.

### LOW

- **L1 — Server counter is a write-only drift generator (dev).** Bumped every
  render (574/590) but nothing reads it; sole consumer (3314) is dead after an
  unconditional return (3310). INVOICE_REDRAFT.md:243 "no counter" is false.
- **L2 — Legacy `saveDraft()` still writes `inv_draft_v1`** when
  `editingDraftId` null (2114-2115; DRAFT_KEY 2879). Re-promotion neutralized
  by `removeItem(DRAFT_KEY)` each boot (2295) → cleanup debt.
- **L3 — `editor` global + `setEditorMode` load-bearing only via legacy
  generate path** (~33 refs). Severing M2 makes the whole cluster deletable.
- **L4 — `insertInvoiceRow` lists `superseded_by` in OPTIONAL_COLUMNS but
  never sends it** (2582) — dead/misleading.
- **L5 — Debounced `persistDrafts` can drop trailing edit on tab-close**
  within 350ms (no pagehide/visibilitychange flush).
- **L6 — Preview number is only a hint;** 23505 retry saves a different number
  with no re-confirm (2489-2490). Final toast is truthful. Documented.

### REFUTED

- **R1 — "Legacy #invoice-status-section buttons clickable on a draft."**
  REFUTED. app.css:3049-3053 hides them via `display:none !important` under
  `[data-draft-mode="1"]` (set by `refreshDraftEditorChrome` 2377). Detail
  mode innerHTML-replaces the section (2762). Dead-code cleanup only.

---

## 3. Target architecture

### 3.1 PDF generation (kill the freeze)
- One client helper with bounded wait: fold `requestPdfGeneration` into the
  AbortController+timeout pattern of `API()` (~25s) → reject with toast.
- `setIssueBusy(busy)` toggles BOTH `#issue-btn` and `#mobile-issue-btn`
  (single re-entry guard). Replace lookups at 2459/2461/2529.
- generate_pdf.js:856 `waitUntil:"domcontentloaded"` (the `document.fonts.ready`
  block at 857-865 already gates fonts) + explicit setContent timeout.
  Self-host all four fonts in every env (generalize VERCEL_FONT_URLS 145-154);
  drop remote FONT_LINKS reliance.

### 3.2 Numbering (one authority)
- DB unique `(user_id, number)` is sole authority; `computeNextInvoiceNumber`
  is a preview only.
- server.py must NOT override: change 558/586 to honor the sent number, stop
  bumping the counter (remove 574-575, 590-591). Dev matches production.
- Re-render PDF after a retry changes the number so PDF and row never diverge.

### 3.3 Linking (server-authoritative seed)
- `buildIssueRecord`: `customer_id: draft.customer_id || selCustId || null`
  (same for company_id), app.js:2555-2556.
- Rehydrate `selCustId/selCompId` from `d.*` in `bindEditorToDraft` (after
  resetEditorForm, ~2349) so the UI reflects the link.
- Add customer name-fallback to the customer rollup (match company, 4060 vs 3891).

### 3.4 Supersede (atomic intent)
- Don't delete the draft unless the void succeeded; reorder 2502-2510 / retry.

### 3.5 Single persistence system
- Delete the legacy generate/persist path; re-point "Share PDF" (index.html:437)
  at the v2 last-PDF flow (`openLastPdf`/`shareGeneratedPdf`).

---

## 4. Ordered fix plan

1. **Kill the freeze (H1+H2+H3)** — smallest blast radius, ship first.
2. **Fix link loss (H4) + rollup asymmetry (M4).**
3. **Unify numbering (H5+L1).**
4. **Make supersede atomic (M1).**
5. **Collapse to one persistence system (M2 + L2/L3/L4 legacy cleanup).**
6. **Harden local mode + edges (M3 + L5 + L6).**

Steps 1-4 are correctness/UX and land before the large legacy deletion in
step 5 (mechanical once M2's persist branch is severed). Step 6 is hardening.
