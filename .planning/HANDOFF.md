# Handoff — Invoice Maker (2026-06-04)

Context for the next agent picking up this app. Read this top-to-bottom
before touching code. There is a lot of history; the key risks are at the
bottom ("Gotchas") — read those first if short on time.

## Fixed 2026-06-04 (this session) — verified
1. **Arabic not printing on the DEPLOYED PDF.** Root cause: `@sparticuz/chromium`
   v148 **removed `chromium.font()`** (introspected: the module no longer
   exposes `.font`/`.headless`). The old `ensureVercelFonts()` called it inside
   a `try/catch`, so it threw and silently registered **no** Arabic font on the
   serverless Chromium (which ships none) — Latin survived via Google Fonts,
   Arabic went blank. Fix: bundled `fonts/NotoNaskhArabic-{Regular,Bold}.ttf`
   and embed them as base64 `@font-face` in every template via
   `EMBEDDED_FONT_CSS` (injected through `FONT_LINKS` for the inline renderers
   and into `</head>` for `template_meridian.html`). PDF is now self-contained —
   no `chromium.font()`, no Google-Fonts-CDN dependency. Also appended
   `"Noto Naskh Arabic"` to the `.arabic-title` font stacks (legacy + aurora_v2
   + meridian template) so decorative Arabic titles render on the deploy, set
   `headless: true` in `browserLaunchOptions` (v148 dropped `chromium.headless`),
   and added `vercel.json` `config.includeFiles: ["fonts/**","template_meridian.html"]`
   so the function bundle actually contains the fonts (the runtime read uses a
   variable filename, which `@vercel/nft` can't auto-trace). Verified by
   rendering with **all** Google Fonts `<link>`s stripped (mimics serverless):
   every Arabic string renders from the embed; `document.fonts.check` true.
   **Deploy note:** commit `fonts/` + redeploy for the fix to take effect.
2. **Company selection.** `loadCompanies()` force-applied `companies[0]` to the
   editor whenever `selCompId` was falsy — running on every boot/sign-in. It
   clobbered "Individual" drafts (overwrote the seller fields + set
   `company_id`) and overwrote the remembered choice via
   `rememberLastCompany(companies[0])`, so the Individual selection never stuck.
   Fix: removed the auto-default from all three branches; the seller/company now
   comes only from the draft record (`bindEditorToDraft`/`applyPayloadToForm`),
   the `#issue-company` selector, or `lastCompanySeed()` for brand-new drafts.
   Added a `renderIssueCompanyOptions()` refresh in each branch so the selector
   stays in sync after companies load. Verified end-to-end (16/16 headless
   checks): Individual draft no longer clobbered → selector drives
   `company_id`/seller/last-company → switching back to Individual clears it →
   persists with no company; zero page errors.

## What this app is
Single-page invoice maker. Vanilla JS frontend (`app.js` ~4500 lines,
`index.html`, `app.css`), Flask dev server (`server.py`), Node PDF renderer
(`generate_pdf.js` via Puppeteer). Deploys to Vercel (static + Python
function + `api/generate-pdf.js` Node function). Supabase for auth + data
(invoices/customers/companies), with a localStorage fallback when not
signed in.

Hub-and-spoke routes: `#/home`, `#/drafts`, `#/drafts/<local_id>` (the
editor), `#/invoices`, `#/invoices/<id>` (read-only detail), `#/customers`,
`#/companies`, `#/financial`, `#/settings`. `#/editor` redirects to
`#/drafts`.

## Invoice model (the redraft — already shipped)
Drafts and issued invoices are **separate**:
- **Draft** = client-only record in localStorage `inv_drafts_v2`, keyed by
  `local_id` (`d_...`). No invoice number. Multiple coexist. See
  `loadDrafts/newDraft/saveDraftV2/deleteDraftV2/getDraft/listDrafts`.
- **Issued invoice** = row in Supabase `public.invoices` (or local JSON).
  Number assigned at issuance; DB unique index `(user_id, number)` is the
  authority; client `computeNextInvoiceNumber()` is a preview only.
- Editor binds to a draft via `bindEditorToDraft(local_id)`. Autosave
  routes through `writeEditingDraft()` → `saveDraftV2`. `collectData()`
  intentionally omits `company_id`/`customer_id`/`supersedes` — those are
  stashed directly on the draft record and preserved by the `{...existing,
  ...data}` spread in `saveDraftV2`.
- Issue flow: `issueDraft()` → confirm → `renderPdfForData()` →
  `insertInvoiceRow()` (retry on 23505 unique violation) → `deleteDraftV2`
  → `openInvoiceDetail(savedId)`. Editing an issued invoice = supersede:
  `startSupersedeFlow(id)` clones it into a new draft tagged `.supersedes`;
  issuing voids the original and sets `superseded_by`.

Full audit of this flow (findings + architecture) is in
`.planning/INVOICE_FLOW_AUDIT.md`. Prior plans:
`INVOICE_REDRAFT.md`, `APP_RESTRUCTURE.md`, `INVOICE_EDITOR_OVERHAUL.md`.

## Migrations (run in Supabase SQL editor, in date order)
All in `supabase/migrations/`. Confirm with the user which have been
applied to their Supabase project:
- `2026-05-28-invoices.sql` — base invoices table.
- `2026-05-29-invoice-void-status.sql` — adds `void` status.
- `2026-05-29-invoice-company-link.sql` — adds `company_id` FK.
- `2026-05-30-invoice-supersede.sql` — adds `superseded_by` + the
  `(user_id, number)` unique index.

## UNCOMMITTED work in the tree right now (4 files: app.js, app.css, index.html, generate_pdf.js)
This session's changes are **not committed**. The last pushed commit was
`36d2e84` (freeze + numbering + auth-load + empty-company). Everything
below is on top of that, in the working tree only:

1. **Save-freeze hardening (DONE, verified).** `withTimeout()` wraps each
   Supabase insert attempt (15s) in `insertInvoiceRow` so a stalled DB call
   (VPN/network) can't hang the Save button forever. Bad `company_id`/
   `customer_id` (FK 23503 / invalid-uuid 22P02) is dropped and the insert
   retried so a stale link never blocks saving. `requestPdfGeneration`
   already had a 25s AbortController timeout (in `36d2e84`).
   - Root cause of the user's "freeze on saving when a company is selected":
     blank company → `company_id:null` → no DB stall; selected company →
     insert includes `company_id` → stalled FK lookup hung the await.

2. **PDF date format (DONE, verified all 6 templates).** New `fmtDate()` in
   `generate_pdf.js` renders ISO `YYYY-MM-DD` as `D/M/YYYY` (e.g.
   `14/3/2026`). Applied at the three renderers' date points. The editor's
   native `<input type=date>` still shows browser-locale format — that's an
   unstyleable native control; only the PDF was changed.

3. **In-editor company selector + indicator (NEW, NOT YET TESTED).** Added a
   "Issuing from" `<select id="issue-company">` to the Issue card
   (`index.html`). Wired in `app.js`: `renderIssueCompanyOptions()` (called
   from `refreshDraftEditorChrome`) populates it from `companies` and
   reflects the draft's `company_id`; `onIssueCompanyChange()` applies the
   pick to the seller fields + `selCompId` + `drafts[id].company_id`,
   remembers it via `rememberLastCompany()`, and re-saves. CSS for
   `.issue-company-field` added. **This is the start of the company
   overhaul the user asked for — see "Open work" below. Needs a browser
   test.**

4. **Company persistence helpers (DONE but was flaky — see Open work).**
   `LAST_COMPANY_KEY`/`rememberLastCompany`/`getLastCompany`/
   `lastCompanySeed`/`newDraftWithLastCompany`. Generic "+ New invoice"
   entry points (`newInvoiceFromHome`, `newInvoiceFromList`) seed the
   last-used company; `startIndividualInvoice` clears it;
   `startNewInvoiceForCompany` and `applyCompanyToInvoice` set it.

## Open work (what the user wants next)
1. **Company overhaul (user asked to "plan an overhaul").** The underlying
   problem: the seller/company card in the editor is `display:none`
   (`app.css` `.seller-card`), so there was never a first-class way to see
   or pick the invoice's company — persistence was a localStorage hack on
   top of a missing feature. The new Issue-card `#issue-company` selector
   (item 3 above) is the first real step. Still to do / decide:
   - Verify the selector actually drives `company_id` end-to-end (pick a
     company → issue → invoice saved with that `company_id` → shows on the
     Companies page rollup).
   - Decide whether the hidden `.seller-card` should be removed entirely now
     that the selector exists (it still holds the `s-name/s-addr/...` inputs
     that `collectData()` reads — the selector writes into them, so don't
     delete the inputs, just the visible card UI if desired).
   - Company default for brand-new sessions: `getLastCompany()` returns null
     if `companies` isn't loaded yet. For signed-in users companies load in
     boot before routeView, so it's usually fine, but confirm.
2. **Company indicator on ISSUED invoices (user asked: "add company
   indicator on invoice").** The Issue-card selector covers drafts. Still
   need to show the company on: the invoice **detail** page
   (`renderInvoiceDetail`/`setInvoiceViewerChrome`), the **invoices list**
   rows (`rowHtml`), and optionally as a column on the Companies page. The
   data is `inv.company_id` → look up in `companies`, fall back to
   `inv.payload.seller.name`.
3. **Audit Steps 4–6 (from INVOICE_FLOW_AUDIT.md), not started:**
   - Step 4 — atomic supersede (M1): don't `deleteDraftV2` if the void
     patch fails.
   - Step 5 — collapse to one persistence system: delete the dead legacy
     path (`editor` global + `setEditorMode`, `persistGeneratedInvoice`,
     `generateInvoice`, `generatePdfFile` persist branch, `saveDraft`/
     `inv_draft_v1`, editing-banner cluster, `loadInvoiceNumber`/
     `setInvoiceNumber` counter, auto-issue toggle, `generateMobilePdf`/
     `shareMobilePdf` legacy persist). Big mechanical deletion — do as its
     own reviewed pass. Re-point the PDF-preview "Share PDF" button off the
     legacy persist path first.
   - Step 6 — harden local mode + edges (M3 local number uniqueness, L5
     pagehide draft flush, L6 retry-number toast).
4. **Supabase login on the DEPLOYED site.** Not a code bug — the deploy has
   no `SUPABASE_URL`/`SUPABASE_ANON_KEY` env vars (the local
   `data/supabase_config.json` is gitignored). User agreed to add them in
   Vercel → Settings → Environment Variables (values are in their local
   `data/supabase_config.json`), then redeploy. The anon key is the public
   client key.

## How to run / test locally
- Start ONE server: `.venv\Scripts\python.exe server.py` (serves
  `localhost:5050`). Static files (`app.js/css`, `index.html`) and
  `generate_pdf.js` (run as a per-request subprocess) are read fresh each
  request — **no restart needed** for changes to those. Only `server.py`
  changes need a restart.
- Syntax check: `node --check app.js`, `node --check generate_pdf.js`,
  `python -c "import ast; ast.parse(open('server.py',encoding='utf-8').read())"`.
- Render a template's HTML directly (fast unit check, no browser):
  `node -e 'const {renderTemplate}=require("./generate_pdf.js"); console.log(renderTemplate({...}))'`.
- Headless browser test harness (used throughout this session): launch
  `puppeteer-core` with the system Chrome at
  `C:/Program Files/Google/Chrome/Application/chrome.exe`, intercept
  `/api/supabase-config` to return `{enabled:false}` for local-data mode,
  drive `location.hash`, assert on `view-*` `hidden` + computed styles +
  `pageerror`. Examples are in this session's transcript.

## GOTCHAS (read these — they cost hours this session)
- **`pkill` does NOT work** for the Flask server on Windows (the Bash tool's
  POSIX pkill can't see the Windows python process). Use PowerShell:
  `Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object
  { $_.CommandLine -match 'server\.py' } | Stop-Process -Force`. Beware:
  a `-like '*server.py*'` filter ALSO matches VSCode's
  `run-jedi-language-server.py` — filter precisely or you'll miscount.
  Repeated `python server.py &` launches stacked 8 stale servers serving
  old code; if behavior seems not to update, check for duplicate processes.
- **server.py used to override the invoice number** with its own
  `settings.json` counter — fixed in `36d2e84` (now honors the client's
  number). If a PDF shows a wrong/stale number again, check that fix didn't
  regress and that no `next_invoice_number` counter logic came back.
- **`auth-locked` body class** must NOT hide `#view-invoice` — that blanked
  the editor (fixed: the auth modal's opaque backdrop covers content
  instead). Don't re-add `#view-invoice` to the `body.auth-locked` hide
  list in `app.css`.
- **Boot order matters**: `loadDrafts()` + `migrateLegacyDraftIfNeeded()`
  run before the first `routeView()` so a direct hit on `#/drafts/<id>`
  finds its record. Don't move routeView before draft load.
- **After Supabase sign-in**, `signInSupabase` and `onAuthStateChange` must
  call `loadInvoices()` + `routeView()` (fixed in `36d2e84`) — otherwise the
  signed-in user's invoices never load.
- Empty-company invoices: `generate_pdf.js` omits the company header + FROM
  block when `seller.name` is empty (all 6 templates). The Individual flow
  (`startIndividualInvoice`) seeds an empty seller.
- `git` on Windows warns "LF will be replaced by CRLF" on every add —
  harmless.
- Per the user's global rules: **do NOT run git commit/push or any git
  write op unless the user explicitly says so.** Schema changes go through
  migration files only, never raw SQL.

## Suggested first moves for the next agent
1. Pull up `localhost:5050`, hard-refresh, open a draft, and test the new
   `#issue-company` selector: pick a company → Save & Print → confirm the
   saved invoice carries `company_id` (Companies page rollup shows it).
2. If solid, add the company indicator to `renderInvoiceDetail` + `rowHtml`
   (open item 2).
3. Then either continue the company overhaul (remove the dead hidden
   seller-card UI, finalize persistence) or move to audit Step 4.
4. Commit only when the user asks.
