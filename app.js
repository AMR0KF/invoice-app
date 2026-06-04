// ── State ──────────────────────────────────────────────────────────────────
let companies  = [];
let customers  = [];
let invoices   = [];   // persisted invoice records — populated by loadInvoices().
// Single source of truth for the editor's binding to a saved record.
// mode === 'new'      → form represents a fresh draft; Generate inserts a
//                        new invoices row and advances the number.
// mode === 'editing'  → form is bound to invoices[id=invoiceId]; Generate
//                        patches that row, does not advance the number,
//                        does not clear the form.
let editor = {
  mode: 'new',
  invoiceId: null,
  boundNumber: null,
  dirty: false,
};
function setEditorMode(mode, inv = null) {
  editor.mode = mode === 'editing' ? 'editing' : 'new';
  editor.invoiceId   = editor.mode === 'editing' ? (inv?.id ?? null) : null;
  editor.boundNumber = editor.mode === 'editing'
    ? (inv?.number ?? inv?.payload?.invoice_number ?? null)
    : null;
  editor.dirty = false;
  if (typeof renderEditingBanner === 'function') renderEditingBanner();
  if (typeof renderEditingSaveButton === 'function') renderEditingSaveButton();
}
let rowCount   = 0;
let selCompId  = null;
let selCustId  = null;
let settingsCompanyId = null;
let lastGeneratedPdf = null;
let supabaseClient = null;
let supabaseUser = null;
let supabaseConfigured = false;
let pdfJsModule = null;
// Per-invoice workflow state (persisted with the draft).
let currentInvoiceStatus = 'draft';   // 'draft' | 'issued' | 'paid'
let currentInvoicePaidDate = null;    // ISO date string when status === 'paid'

// Redraft: when the editor is bound to a v2 draft (#/drafts/<id>), this
// holds the draft's local_id. Autosave routes to v2 storage instead of
// the legacy v1 slot, and the inv-num field is read-only.
let editingDraftId = null;

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Hydrate drafts v2 FIRST so a direct hit on #/drafts/<id> finds its
  // record in the same tick. Without this, the first routeView sees
  // drafts={} and bindEditorToDraft redirects to a freshly-minted id,
  // which (because location.hash = X queues a hashchange instead of
  // re-running synchronously) leaves the page in an unresolved state
  // until the await chain below completes — long enough for the user
  // to see a blank form.
  loadDrafts();
  migrateLegacyDraftIfNeeded();

  // Set today's date + seed one empty line item BEFORE routing so the
  // editor view has visible structure when it's unhidden.
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('inv-date').value = today;
  document.getElementById('inv-due').value  = new Date(Date.now() + 7*864e5).toISOString().split('T')[0];
  loadDocumentSettings();
  renderItemHistoryDatalist();
  toggleDiscount();
  if (!rowCount) addRow();

  // Wire input listeners before routing so any typing the user does
  // while async work is in flight is captured.
  wireDraftAutosave();

  // Route now — drafts + form structure are ready. The right view
  // appears immediately; any data that comes later (invoices,
  // customers, companies) re-renders via the trailing routeView().
  routeView();

  await initSupabaseAuth();
  await loadInvoices().catch(() => {});
  if (supabaseActive()) {
    await loadCompanies();
    await loadCustomers();
  }
  // Final routeView after all async work — re-renders the active view
  // with the now-loaded data (especially Home's hero stats).
  routeView();
});

// Delegate listener so autosave catches every input/change in the invoice
// view (notes, buyer fields, template/lang selects, etc.) — not just the
// ones routed through recalc().
function wireDraftAutosave() {
  const view = document.getElementById('view-invoice');
  if (!view || view.dataset.autosaveWired === '1') return;
  view.addEventListener('input',  onEditorInput);
  view.addEventListener('change', onEditorInput);
  view.dataset.autosaveWired = '1';

  // Number field: break the editing binding the moment the user types a
  // number that no longer matches the bound record. Otherwise the next
  // Generate would patch the original record with a different number's data.
  const numEl = document.getElementById('inv-num');
  if (numEl && numEl.dataset.numListenerWired !== '1') {
    numEl.addEventListener('input', (e) => {
      // In v2 draft-edit mode, the field is read-only and shows a live
      // next-number hint — user can't actually change it. Skip the
      // legacy binding-break logic entirely.
      if (editingDraftId) return;
      if (editor.mode !== 'editing') return;
      if (_draftRestoring) return;
      const v = (e.target.value || '').trim();
      if (v && v !== editor.boundNumber) {
        setEditorMode('new');
        toast('Number changed — this will save as a new invoice', 'info');
      }
    });
    numEl.dataset.numListenerWired = '1';
  }
}

// Single delegated handler for any input/change inside #view-invoice.
//   - draft-edit route: route writes to v2 draft slot.
//   - legacy 'editing' mode: flip dirty so Save button enables.
//   - legacy 'new' mode: persist into inv_draft_v1 (debounced).
function onEditorInput() {
  if (_draftRestoring) return;
  // New world: the form is bound to a v2 draft. Autosave per-draft.
  if (editingDraftId) {
    writeEditingDraft();
    // The next-number hint depends on the invoices list, which can
    // change between renders. Refresh on every input so the field
    // stays accurate even after a draft autosave triggers nothing else.
    return;
  }
  if (editor.mode === 'editing') {
    if (!editor.dirty) {
      editor.dirty = true;
      if (typeof renderEditingSaveButton === 'function') renderEditingSaveButton();
    }
    return;
  }
  saveDraft();
}

// ── Language toggle ────────────────────────────────────────────────────────
// ── Due date toggle ────────────────────────────────────────────────────────
function toggleDue() {
  const chk = document.getElementById('chk-due');
  const inp = document.getElementById('inv-due');
  inp.style.display = chk.checked ? 'block' : 'none';
}

function toggleDiscount() {
  document.body.classList.toggle('show-discount', document.getElementById('chk-discount').checked);
  recalc();
}

// Settings
function applyTheme(theme) {
  const normalized = theme === 'light' ? 'light' : 'dark';
  document.body.classList.toggle('light-theme', normalized === 'light');
  const toggle = document.getElementById('settings-theme-toggle');
  if (toggle) toggle.checked = normalized === 'light';
}

async function toggleThemeSetting() {
  const theme = document.getElementById('settings-theme-toggle').checked ? 'light' : 'dark';
  localStorage.setItem('inv_theme', theme);
  applyTheme(theme);
  await saveRemoteDocumentSettings();
  toast(theme === 'light' ? 'Light mode enabled' : 'Dark mode enabled', 'success');
}

function toggleAutoIssue() {
  const on = document.getElementById('settings-auto-issue').checked;
  localStorage.setItem('inv_auto_issue', on ? '1' : '0');
  toast(on ? 'Will auto-mark issued on generate' : 'Manual status only', 'success');
}

function toggleYearPrefix() {
  const on = document.getElementById('settings-year-prefix').checked;
  localStorage.setItem('inv_year_prefix', on ? '1' : '0');
  // Re-apply current invoice number through the new formatter so the field
  // updates immediately to the new format (or back to legacy).
  const current = document.getElementById('inv-num')?.value || 'INV-001';
  if (on) {
    setInvoiceNumber(current);
    toast('Year-prefixed numbers enabled', 'success');
  } else {
    // Strip the year segment if present so we revert to legacy "INV-###".
    const stripped = current.replace(/^(.*?)-(\d{4})-(\d+)$/, '$1-$3');
    setInvoiceNumber(stripped);
    toast('Year-prefix turned off', 'success');
  }
}

function applyDocLangClass(lang) {
  document.body.classList.remove('doc-lang-en', 'doc-lang-ar', 'doc-lang-bi');
  document.body.classList.add(`doc-lang-${lang || 'bi'}`);
}

function loadDocumentSettings() {
  const saved = localStorage.getItem('inv_default_currency') || 'USD';
  const currency = saved === 'LBP' ? 'LBP' : 'USD';
  const lang = ['en', 'ar', 'bi'].includes(localStorage.getItem('inv_doc_lang')) ? localStorage.getItem('inv_doc_lang') : 'bi';
  const template = normalizeTemplate(localStorage.getItem('inv_template') || 'aurora');
  const vatPct = localStorage.getItem('inv_vat_pct') || '0';
  const theme = localStorage.getItem('inv_theme') === 'light' ? 'light' : 'dark';
  const yearPrefix = localStorage.getItem('inv_year_prefix') === '1';
  applyTheme(theme);

  document.getElementById('currency').value = currency;
  document.getElementById('doc-lang').value = lang;
  document.getElementById('invoice-template').value = template;
  document.getElementById('vat-pct').value = vatPct;

  applyDocLangClass(lang);
  if (document.getElementById('settings-currency')) document.getElementById('settings-currency').value = currency;
  if (document.getElementById('settings-doc-lang')) document.getElementById('settings-doc-lang').value = lang;
  if (document.getElementById('settings-template')) document.getElementById('settings-template').value = template;
  if (document.getElementById('side-template')) document.getElementById('side-template').value = template;
  if (document.getElementById('mobile-template')) document.getElementById('mobile-template').value = template;
  if (document.getElementById('settings-vat-pct')) document.getElementById('settings-vat-pct').value = vatPct;
  const yearChk = document.getElementById('settings-year-prefix');
  if (yearChk) yearChk.checked = yearPrefix;
  const autoChk = document.getElementById('settings-auto-issue');
  if (autoChk) autoChk.checked = localStorage.getItem('inv_auto_issue') !== '0';
  recalc();
  updateActionSummary();
}

// Year-prefixed invoice numbers: when enabled, the canonical format becomes
// "INV-YYYY-###". On year rollover the sequence resets to 001 automatically.
// When disabled, the number is whatever the server returned (legacy format).
function isYearPrefixEnabled() {
  return localStorage.getItem('inv_year_prefix') === '1';
}

function applyYearPrefixIfNeeded(rawNumber) {
  if (!isYearPrefixEnabled() || !rawNumber) return rawNumber;
  const year = new Date().getFullYear();
  // Parse the raw number into prefix + optional year segment + digits.
  // We accept "INV-005", "INV-2025-005", "INV-2026-12", or custom prefixes.
  const m = String(rawNumber).match(/^(.*?)(?:-(\d{4}))?-?(\d+)$/);
  if (!m) return rawNumber;
  let head = (m[1] || 'INV').replace(/-+$/, '');
  const storedYear = m[2] ? parseInt(m[2], 10) : null;
  let seq = m[3] || '1';
  // Year mismatch (or no year in stored value) → reset sequence on rollover.
  if (storedYear !== year) seq = '001';
  const padded = seq.padStart(Math.max(3, seq.length), '0');
  return `${head}-${year}-${padded}`;
}

function currentDocumentSettings() {
  const currency = document.getElementById('currency').value === 'LBP' ? 'LBP' : 'USD';
  return {
    currency,
    doc_language: document.getElementById('doc-lang').value || 'bi',
    template: normalizeTemplate(document.getElementById('invoice-template').value),
    vat_pct: parseFloat(document.getElementById('vat-pct').value) || 0,
    theme: document.body.classList.contains('light-theme') ? 'light' : 'dark',
  };
}

async function loadRemoteDocumentSettings() {
  if (!supabaseActive()) return;
  const { data, error } = await supabaseClient
    .from('user_settings')
    .select('currency,doc_language,template,vat_pct,theme')
    .eq('user_id', supabaseUser.id)
    .maybeSingle();
  if (error) {
    console.warn('Supabase settings load skipped:', error.message || error);
    return;
  }
  if (!data) {
    await saveRemoteDocumentSettings(false);
    return;
  }

  localStorage.setItem('inv_default_currency', data.currency || 'USD');
  localStorage.setItem('inv_doc_lang', data.doc_language || 'bi');
  localStorage.setItem('inv_template', normalizeTemplate(data.template || 'aurora'));
  localStorage.setItem('inv_vat_pct', String(data.vat_pct || 0));
  localStorage.setItem('inv_theme', data.theme === 'light' ? 'light' : 'dark');
  loadDocumentSettings();
}

async function saveRemoteDocumentSettings(showError = true) {
  if (!supabaseActive()) return;
  const settings = currentDocumentSettings();
  const { error } = await supabaseClient
    .from('user_settings')
    .upsert({ user_id: supabaseUser.id, ...settings }, { onConflict: 'user_id' });
  if (error && showError) toast(error.message || 'Could not save Supabase settings', 'error');
}

async function saveDocumentSettings() {
  const currency = document.getElementById('settings-currency').value === 'LBP' ? 'LBP' : 'USD';
  const lang = ['en', 'ar', 'bi'].includes(document.getElementById('settings-doc-lang').value) ? document.getElementById('settings-doc-lang').value : 'bi';
  const template = normalizeTemplate(document.getElementById('settings-template').value);
  const vatPct = String(parseFloat(document.getElementById('settings-vat-pct').value) || 0);

  localStorage.setItem('inv_default_currency', currency);
  localStorage.setItem('inv_doc_lang', lang);
  localStorage.setItem('inv_template', template);
  localStorage.setItem('inv_vat_pct', vatPct);

  document.getElementById('currency').value = currency;
  document.getElementById('doc-lang').value = lang;
  document.getElementById('invoice-template').value = template;
  document.getElementById('vat-pct').value = vatPct;
  if (document.getElementById('side-template')) document.getElementById('side-template').value = template;
  if (document.getElementById('mobile-template')) document.getElementById('mobile-template').value = template;
  applyDocLangClass(lang);
  recalc();
  await saveRemoteDocumentSettings();
  toast('Document settings saved', 'success');
}

async function setTemplateFromSidePanel() {
  const template = normalizeTemplate(document.getElementById('side-template').value);
  document.getElementById('invoice-template').value = template;
  if (document.getElementById('settings-template')) document.getElementById('settings-template').value = template;
  if (document.getElementById('mobile-template')) document.getElementById('mobile-template').value = template;
  localStorage.setItem('inv_template', template);
  await saveRemoteDocumentSettings();
  updateActionSummary();
  toast('Design updated', 'success');
}

async function setTemplateFromMobileNotes() {
  const template = normalizeTemplate(document.getElementById('mobile-template').value);
  document.getElementById('invoice-template').value = template;
  if (document.getElementById('settings-template')) document.getElementById('settings-template').value = template;
  if (document.getElementById('side-template')) document.getElementById('side-template').value = template;
  localStorage.setItem('inv_template', template);
  await saveRemoteDocumentSettings();
  updateActionSummary();
  toast('Design updated', 'success');
}

function normalizeTemplate(value) {
  const allowed = ['aurora', 'aurora_v2', 'meridian', 'meridian_v2', 'obsidian', 'classic'];
  return allowed.includes(value) ? value : 'aurora';
}

function templateLabel(value) {
  return ({ aurora: 'Aurora', aurora_v2: 'Aurora v2', meridian: 'Meridian', meridian_v2: 'Meridian v2', obsidian: 'Obsidian', classic: 'Classic' })[value] || 'Aurora';
}

function updateActionSummary() {
  const templateEl = document.getElementById('invoice-template');
  const totalEl = document.getElementById('t-grand');
  const actionTemplate = document.getElementById('action-template');
  const actionTotal = document.getElementById('action-total');
  const mobileTotal = document.getElementById('mobile-total');
  if (actionTemplate && templateEl) actionTemplate.textContent = templateLabel(templateEl.value);
  if (document.getElementById('side-template') && templateEl) document.getElementById('side-template').value = templateEl.value;
  if (document.getElementById('mobile-template') && templateEl) document.getElementById('mobile-template').value = templateEl.value;
  if (actionTotal && totalEl) actionTotal.textContent = totalEl.textContent;
  if (mobileTotal && totalEl) mobileTotal.textContent = totalEl.textContent;
  const genBtn = document.getElementById('gen-btn');
  if (genBtn && !genBtn.disabled) {
    genBtn.textContent = 'Generate Invoice (PDF) / إنشاء الفاتورة';
  }
}

// Single source of truth for which route the URL currently points to.
// All route comparisons should go through this — never hand-roll
// `hash.startsWith(...)` again.
//
// Empty hash and `#/` default to HOME (the landing page).
//
// Invoice lifecycle routes (added in the redraft):
//   #/drafts                 — list of unsent drafts
//   #/drafts/<local_id>      — edit one draft (the new "editor")
//   #/invoices/<id>          — view one issued invoice (read-only)
//   #/invoices/<id>/edit     — supersede flow (creates a new draft)
//   #/editor                 — legacy bookmark; alias for #/drafts
function currentRouteName() {
  const h = location.hash || '';
  // Drafts must check the `/<id>` variant first so it doesn't match the
  // list route. Same for invoices.
  if (h.startsWith('#/drafts/'))      return 'draft-edit';
  if (h.startsWith('#/drafts'))       return 'drafts';
  if (h.startsWith('#/invoices/') && h.endsWith('/edit')) return 'invoice-edit';
  if (h.startsWith('#/invoices/'))    return 'invoice-detail';
  if (h.startsWith('#/invoices'))     return 'invoices';
  if (h.startsWith('#/editor'))       return 'editor';   // legacy
  if (h.startsWith('#/home'))         return 'home';
  if (h.startsWith('#/customers/'))   return 'customer-detail';
  if (h.startsWith('#/customers'))    return 'customers';
  if (h.startsWith('#/companies/'))   return 'company-detail';
  if (h.startsWith('#/companies'))    return 'companies';
  if (h.startsWith('#/financial'))    return 'financial';
  if (h.startsWith('#/settings'))     return 'settings';
  return 'home';
}

// Map route → topbar nav-link data-route value (for active highlighting).
function navHighlightFor(route) {
  if (route === 'customer-detail') return 'customers';
  if (route === 'company-detail')  return 'companies';
  if (route === 'invoice-detail')  return 'invoices';
  if (route === 'invoice-edit')    return 'drafts';
  if (route === 'editor')          return 'drafts';   // legacy redirect target
  if (route === 'draft-edit')      return 'drafts';
  return route;
}

const ALL_VIEW_IDS = [
  'view-home', 'view-invoice', 'view-invoices', 'view-customers',
  'view-customer', 'view-companies', 'view-company', 'view-financial',
  'view-settings', 'view-drafts',
];

function routeView() {
  let route = currentRouteName();
  const hash  = (location.hash || '').replace(/^#/, '');
  // Legacy #/editor: redirect to #/drafts (the new landing for the editor).
  // The redirect triggers another hashchange → routeView, so just bail.
  if (route === 'editor') {
    location.hash = '#/drafts';
    return;
  }
  // Leaving a draft-edit route unbinds the editor from v2 storage so
  // later input events don't write back to the draft we just closed.
  if (route !== 'draft-edit' && editingDraftId) {
    editingDraftId = null;
    if (typeof clearDraftEditorChrome === 'function') clearDraftEditorChrome();
  }
  // Leaving an invoice-detail route restores normal editor chrome.
  if (route !== 'invoice-detail' && viewingInvoiceId) {
    viewingInvoiceId = null;
    if (typeof clearInvoiceViewerChrome === 'function') clearInvoiceViewerChrome();
  }
  const navRoute = navHighlightFor(route);

  // Map each route to the section element it shows. Draft-edit and
  // invoice-detail reuse `view-invoice` (the editor's DOM) — the
  // editor-binding logic (step 5+) configures it for read-only vs
  // editable mode based on the route.
  const visibleId = ({
    home:              'view-home',
    drafts:            'view-drafts',
    'draft-edit':      'view-invoice',
    'invoice-detail':  'view-invoice',
    'invoice-edit':    'view-invoice',
    invoices:          'view-invoices',
    customers:         'view-customers',
    'customer-detail': 'view-customer',
    companies:         'view-companies',
    'company-detail':  'view-company',
    financial:         'view-financial',
    settings:          'view-settings',
  })[route];

  // Hide everything, then unhide the active view.
  ALL_VIEW_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = (id !== visibleId);
  });

  // Body classes (used by responsive CSS that hides chrome on sub-pages).
  document.body.classList.toggle('on-settings',     route === 'settings');
  document.body.classList.toggle('on-invoices',     route === 'invoices');
  document.body.classList.toggle('on-customer',     route === 'customer-detail');
  document.body.classList.toggle('on-customers',    route === 'customers');
  document.body.classList.toggle('on-companies',    route === 'companies' || route === 'company-detail');
  document.body.classList.toggle('on-financial',    route === 'financial');
  document.body.classList.toggle('on-home',         route === 'home');
  document.body.classList.toggle('on-drafts',       route === 'drafts');
  document.body.classList.toggle('on-draft-edit',   route === 'draft-edit');
  document.body.classList.toggle('on-invoice-view', route === 'invoice-detail' || route === 'invoice-edit');

  document.querySelectorAll('.topbar-nav .nav-link').forEach(el => {
    el.classList.toggle('active', el.dataset.route === navRoute);
  });

  // Per-route work.
  if (route === 'home') {
    if (typeof renderHomePage === 'function') renderHomePage();
    loadInvoices().then(() => { if (typeof renderHomePage === 'function') renderHomePage(); }).catch(() => {});
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }
  if (route === 'invoices') {
    renderInvoicesPage();
    loadInvoices().then(renderInvoicesPage).catch(() => {});
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }
  if (route === 'customers') {
    if (typeof renderCustomersPage === 'function') renderCustomersPage();
    loadInvoices().then(() => { if (typeof renderCustomersPage === 'function') renderCustomersPage(); }).catch(() => {});
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }
  if (route === 'customer-detail') {
    const cid = hash.split('/')[2] || '';
    renderCustomerDetail(cid);
    loadInvoices().then(() => renderCustomerDetail(cid)).catch(() => {});
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }
  if (route === 'companies') {
    if (typeof renderCompaniesPage === 'function') renderCompaniesPage();
    loadInvoices().then(() => { if (typeof renderCompaniesPage === 'function') renderCompaniesPage(); }).catch(() => {});
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }
  if (route === 'company-detail') {
    const cid = hash.split('/')[2] || '';
    if (typeof renderCompanyDetail === 'function') renderCompanyDetail(cid);
    loadInvoices().then(() => { if (typeof renderCompanyDetail === 'function') renderCompanyDetail(cid); }).catch(() => {});
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }
  if (route === 'financial') {
    if (typeof renderFinancialPage === 'function') renderFinancialPage();
    loadInvoices().then(() => { if (typeof renderFinancialPage === 'function') renderFinancialPage(); }).catch(() => {});
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }
  if (route === 'settings') {
    const anchor = hash.split('/')[2] || '';
    loadDocumentSettings();
    renderSettingsCompanyList();
    if (settingsCompanyId && companies.some(c => c.id === settingsCompanyId)) {
      selectSettingsCompany(settingsCompanyId);
    } else if (companies.length) {
      selectSettingsCompany(companies[0].id);
    } else {
      newSettingsCompany({ silent: true });
    }
    const target = anchor ? document.querySelector(`[data-section="${anchor}"]`) : null;
    if (target) target.scrollIntoView({ behavior: 'auto', block: 'start' });
    else window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }
  if (route === 'drafts') {
    if (typeof renderDraftsPage === 'function') renderDraftsPage();
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }
  if (route === 'draft-edit') {
    const local_id = hash.split('/')[2] || '';
    bindEditorToDraft(local_id);
    return;
  }
  if (route === 'invoice-detail') {
    // Read-only view of one invoice. Step 7 builds the renderer; for
    // now the editor view is shown and the user can fall back to the
    // existing "open from list" flow.
    if (typeof renderInvoiceDetail === 'function') {
      const id = hash.split('/')[2] || '';
      renderInvoiceDetail(id);
      loadInvoices().then(() => { if (typeof renderInvoiceDetail === 'function') renderInvoiceDetail(id); }).catch(() => {});
    }
    return;
  }
  if (route === 'invoice-edit') {
    // Supersede flow. Step 8 implements; for now route is a stub so
    // the link doesn't 404.
    if (typeof startSupersedeFlow === 'function') {
      const id = hash.split('/')[2] || '';
      startSupersedeFlow(id);
    }
    return;
  }
}

function openInvoices() {
  if (location.hash === '#/invoices') routeView(); else location.hash = '#/invoices';
}
function openHome() {
  if (location.hash === '#/home') routeView(); else location.hash = '#/home';
}
function openCustomers() {
  if (location.hash === '#/customers') routeView(); else location.hash = '#/customers';
}
function openCompanies() {
  if (location.hash === '#/companies') routeView(); else location.hash = '#/companies';
}
function openFinancial() {
  if (location.hash === '#/financial') routeView(); else location.hash = '#/financial';
}
function openDrafts() {
  // If the user has no drafts yet, skip the empty-state list and drop
  // them straight into a fresh editor — same number of clicks as the
  // legacy editor landing, no "where's the form?" confusion.
  if (Object.keys(drafts || {}).length === 0) {
    const d = newDraft({});
    openDraft(d.local_id);
    return;
  }
  if (location.hash === '#/drafts') routeView(); else location.hash = '#/drafts';
}
function openDraft(local_id) {
  if (!local_id) return;
  location.hash = '#/drafts/' + encodeURIComponent(local_id);
}
function openInvoiceDetail(invoice_id) {
  if (!invoice_id) return;
  location.hash = '#/invoices/' + encodeURIComponent(invoice_id);
}

// Compute a draft's grand total from its persisted items + discounts.
// Mirrors recalc()'s formula but reads from the draft record, not the
// DOM — drafts in the list page haven't been hydrated into the editor.
function draftGrandTotal(d) {
  const items = Array.isArray(d?.items) ? d.items : [];
  const includeDisc = !!d?.include_discount;
  let sub = 0, lineDisc = 0;
  items.forEach(it => {
    const q = Number(it.qty) || 0;
    const u = Number(it.unit_price) || 0;
    const x = includeDisc ? (Number(it.discount_pct) || 0) : 0;
    const gross = q * u;
    sub      += gross;
    lineDisc += gross * (x / 100);
  });
  const afterLines = sub - lineDisc;
  const invDisc = d?.invoice_discount || {};
  let invDiscAmt = 0;
  if (invDisc.enabled) {
    const v = Number(invDisc.value) || 0;
    invDiscAmt = invDisc.type === 'fixed' ? v : afterLines * (v / 100);
    if (invDiscAmt > afterLines) invDiscAmt = afterLines;
  }
  const taxable = afterLines - invDiscAmt;
  const vatPct  = Number(d?.vat_pct) || 0;
  const vatAmt  = taxable * (vatPct / 100);
  return taxable + vatAmt;
}

function renderDraftsPage() {
  const list = document.getElementById('drafts-list');
  if (!list) return;
  const all = listDrafts();
  if (all.length === 0) {
    list.innerHTML = `<div class="invoices-empty">
      <strong>No drafts yet.</strong><br>
      Click <em>+ New draft</em> above to start one.
    </div>`;
    return;
  }
  list.innerHTML = all.map(d => {
    const buyer = d.buyer?.name || '(no buyer yet)';
    const items = Array.isArray(d.items) ? d.items.length : 0;
    const total = draftGrandTotal(d);
    const cur   = d.currency || 'USD';
    const updatedAgo = typeof humanTimeAgo === 'function' ? humanTimeAgo(d.updated_at) : (d.updated_at || '').slice(0, 10);
    return `
      <div class="customer-card" onclick="openDraft('${escapeHtml(d.local_id)}')">
        <div class="customer-card-name">
          <strong>${escapeHtml(buyer)}</strong>
          <span class="meta">${items} item${items === 1 ? '' : 's'}${d.notes ? ' · ' + escapeHtml(d.notes.slice(0, 50)) : ''}</span>
        </div>
        <div class="customer-card-num">
          <span class="label">Total</span>
          <span class="value">${fmtMoney(total, cur)}</span>
        </div>
        <div class="customer-card-num">
          <span class="label">Updated</span>
          <span class="value zero">${escapeHtml(updatedAgo)}</span>
        </div>
        <div class="customer-card-mix">
          <span class="chip">Draft</span>
          ${d.supersedes ? `<span class="chip" style="border-color: color-mix(in srgb, var(--accent) 40%, var(--border))">Replaces ${escapeHtml(d.supersedes_number || '…')}</span>` : ''}
        </div>
        <div class="customer-card-actions" onclick="event.stopPropagation()">
          <button class="ghost-btn" type="button" onclick="openDraft('${escapeHtml(d.local_id)}')">Open</button>
          <button class="ghost-btn danger" type="button" onclick="discardDraft('${escapeHtml(d.local_id)}')">Discard</button>
        </div>
      </div>`;
  }).join('');
}

function newDraftFromList() {
  const d = newDraft({});
  openDraft(d.local_id);
}

function discardDraft(local_id) {
  const d = getDraft(local_id);
  if (!d) return;
  const label = d.buyer?.name ? `the draft for "${d.buyer.name}"` : 'this draft';
  if (!confirm(`Discard ${label}? It can't be recovered.`)) return;
  deleteDraftV2(local_id);
  renderDraftsPage();
  toast('Draft discarded', 'success');
}

// Mobile slide-down nav drawer.
function toggleMobileNav() {
  const d = document.getElementById('mobile-nav-drawer');
  if (!d) return;
  d.hidden = !d.hidden;
  const btn = document.getElementById('topbar-menu-btn');
  if (btn) btn.setAttribute('aria-expanded', String(!d.hidden));
  // Highlight the active route in the drawer when opening.
  if (!d.hidden) {
    const active = navHighlightFor(currentRouteName());
    d.querySelectorAll('.mobile-nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.route === active);
    });
  }
}
function closeMobileNav() {
  const d = document.getElementById('mobile-nav-drawer');
  if (d) d.hidden = true;
  const btn = document.getElementById('topbar-menu-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

// Tapping outside the open drawer closes it.
document.addEventListener('click', (e) => {
  const d = document.getElementById('mobile-nav-drawer');
  if (!d || d.hidden) return;
  const btn = document.getElementById('topbar-menu-btn');
  if (d.contains(e.target) || (btn && btn.contains(e.target))) return;
  closeMobileNav();
});

window.addEventListener('hashchange', routeView);

function openSettings(section = '') {
  const target = section === 'companies' ? '#/settings/companies' : '#/settings';
  if (location.hash === target) routeView(); else location.hash = target;
}

// Mobile gear icon: toggles between settings and invoice views.
function toggleSettingsRoute() {
  if (location.hash.startsWith('#/settings')) goToInvoice();
  else openSettings();
}

function closeSettings() {
  if (!document.getElementById('view-settings').hidden) goToInvoice();
}

// Navigate to the editor (`#/editor`). Used by the topbar Editor tab,
// back buttons that explicitly want the editor, and the "+ New invoice"
// flow after seeding the form.
function goToInvoice() {
  if (location.hash === '#/editor') routeView();
  else location.hash = '#/editor';
}

function closeSettingsOnBackdrop() { /* retained for legacy onclick handlers */ }

function newSettingsCompany(opts = {}) {
  settingsCompanyId = null;
  ['set-company-name','set-company-addr','set-company-phone','set-company-email'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const ind = document.getElementById('set-company-individual');
  if (ind) ind.checked = false;
  updateEditorChrome();
  renderSettingsCompanyList();
  if (opts.silent) return;
  const nameInput = document.getElementById('set-company-name');
  if (nameInput) nameInput.focus({ preventScroll: true });
  const editor = document.getElementById('settings-company-editor');
  if (editor) editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function refreshSettingsCompanies() {
  await loadCompanies();
  if (settingsCompanyId && !companies.some(c => c.id === settingsCompanyId)) settingsCompanyId = null;
  renderSettingsCompanyList();
  toast('Companies refreshed', 'success');
}

function companyInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function renderSettingsCompanyList() {
  const grid = document.getElementById('settings-company-grid');
  if (!grid) return;
  const searchEl = document.getElementById('settings-company-search');
  const search = (searchEl?.value || '').trim().toLowerCase();
  const filtered = !search ? companies : companies.filter(c => {
    return ['name','email','phone','address'].some(k => (c[k]||'').toLowerCase().includes(search));
  });
  const count = companies.length;
  const countEl = document.getElementById('settings-company-count');
  const plural = document.getElementById('settings-company-plural');
  if (countEl) countEl.textContent = String(count);
  if (plural) plural.textContent = count === 1 ? '' : 's';

  grid.innerHTML = '';
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'settings-empty-state';
    if (search) {
      empty.textContent = `No companies match "${search}".`;
    } else {
      empty.innerHTML = 'No companies yet. Click <strong>+ New company</strong> above to add your first profile.';
    }
    grid.appendChild(empty);
    return;
  }

  filtered.forEach(company => {
    const card = document.createElement('article');
    card.className = 'company-card' + (company.id === settingsCompanyId ? ' selected' : '');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Edit ${company.name || 'company'}`);

    const avatar = document.createElement('div');
    avatar.className = 'company-avatar';
    avatar.textContent = companyInitials(company.name);

    const body = document.createElement('div');
    body.className = 'company-card-body';

    const name = document.createElement('div');
    name.className = 'company-card-name';
    name.textContent = company.name || 'Unnamed company';
    body.appendChild(name);

    if (company.individual_disclaimer) {
      const badge = document.createElement('span');
      badge.className = 'company-badge';
      badge.textContent = 'Individual';
      body.appendChild(badge);
    }

    const contact = [company.email, company.phone].filter(Boolean).join(' · ');
    if (contact) {
      const line = document.createElement('div');
      line.className = 'company-card-line';
      line.textContent = contact;
      body.appendChild(line);
    }
    if (company.address) {
      const addr = document.createElement('div');
      addr.className = 'company-card-line muted';
      addr.textContent = company.address;
      body.appendChild(addr);
    }

    const actions = document.createElement('div');
    actions.className = 'company-card-actions';
    const useBtn = document.createElement('button');
    useBtn.type = 'button';
    useBtn.className = 'ghost-btn use-btn';
    useBtn.textContent = 'Use';
    useBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectSettingsCompany(company.id);
      useSettingsCompanyOnInvoice();
    });
    actions.appendChild(useBtn);

    card.appendChild(avatar);
    card.appendChild(body);
    card.appendChild(actions);
    card.addEventListener('click', () => selectSettingsCompany(company.id));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectSettingsCompany(company.id);
      }
    });
    grid.appendChild(card);
  });
}

function updateEditorChrome() {
  const title = document.getElementById('settings-editor-title');
  const sub = document.getElementById('settings-editor-sub');
  const pill = document.getElementById('settings-editor-pill');
  const delBtn = document.getElementById('settings-delete-btn');
  const editing = !!settingsCompanyId;
  const company = editing ? companies.find(c => c.id === settingsCompanyId) : null;
  if (title) title.textContent = editing ? (company?.name || 'Untitled company') : 'New company';
  if (sub) sub.textContent = editing ? 'Update the profile and save changes.' : 'Fill in the details below and save.';
  if (pill) pill.hidden = !editing;
  if (delBtn) delBtn.hidden = !editing;
}

function updateEditorTitle() {
  if (settingsCompanyId) return;
  const name = document.getElementById('set-company-name')?.value.trim();
  const title = document.getElementById('settings-editor-title');
  if (title) title.textContent = name ? name : 'New company';
}

function selectSettingsCompany(id) {
  const company = companies.find(c => c.id === id);
  if (!company) return;
  settingsCompanyId = id;
  const map = {
    'set-company-name': company.name || '',
    'set-company-addr': company.address || '',
    'set-company-phone': company.phone || '',
    'set-company-email': company.email || '',
  };
  for (const [el, val] of Object.entries(map)) {
    const node = document.getElementById(el);
    if (node) node.value = val;
  }
  const ind = document.getElementById('set-company-individual');
  if (ind) ind.checked = !!company.individual_disclaimer;
  updateEditorChrome();
  renderSettingsCompanyList();
}

function collectSettingsCompany() {
  return {
    id: settingsCompanyId || undefined,
    name: document.getElementById('set-company-name').value.trim(),
    address: document.getElementById('set-company-addr').value.trim(),
    phone: document.getElementById('set-company-phone').value.trim(),
    email: document.getElementById('set-company-email').value.trim(),
    individual_disclaimer: document.getElementById('set-company-individual').checked,
  };
}

async function saveSettingsCompany() {
  const company = collectSettingsCompany();
  if (!company.name) { toast('Enter a company name first', 'error'); return; }
  if (supabaseActive()) {
    const payload = {
      name: company.name,
      address: company.address,
      phone: company.phone,
      email: company.email,
      individual_disclaimer: company.individual_disclaimer,
    };
    const query = company.id
      ? supabaseClient.from('companies').update(payload).eq('id', company.id).select('id').single()
      : supabaseClient.from('companies').insert({ ...payload, user_id: supabaseUser.id }).select('id').single();
    const { data, error } = await query;
    if (error) {
      toast(error.message || 'Company save failed', 'error');
      return;
    }
    settingsCompanyId = data.id;
    selCompId = data.id;
    await loadCompanies();
    selectSettingsCompany(settingsCompanyId);
    useSettingsCompanyOnInvoice(false);
    toast('Company saved', 'success');
    return;
  }

  try {
    const r = await API('POST', '/api/companies', company);
    settingsCompanyId = r.id;
    selCompId = r.id;
    await loadCompanies();
  } catch {
    if (!company.id) company.id = 'c' + Date.now();
    const idx = companies.findIndex(c => c.id === company.id);
    if (idx >= 0) companies[idx] = company; else companies.push(company);
    settingsCompanyId = company.id;
    selCompId = company.id;
    localStorage.setItem('inv_companies', JSON.stringify(companies));
    renderDropdown('company');
    renderSettingsCompanyList();
  }
  selectSettingsCompany(settingsCompanyId);
  useSettingsCompanyOnInvoice(false);
  toast('Company saved', 'success');
}

async function deleteSettingsCompany() {
  if (!settingsCompanyId) { toast('Select a company first', 'error'); return; }
  const deletingId = settingsCompanyId;
  if (supabaseActive()) {
    const { error } = await supabaseClient.from('companies').delete().eq('id', deletingId);
    if (error) {
      toast(error.message || 'Company delete failed', 'error');
      return;
    }
    await loadCompanies();
    if (selCompId === deletingId) {
      selCompId = null;
      ['s-name','s-addr','s-phone','s-email'].forEach(id => document.getElementById(id).value = '');
      document.getElementById('chk-individual-disclaimer').checked = false;
    }
    settingsCompanyId = companies[0]?.id || null;
    if (settingsCompanyId) selectSettingsCompany(settingsCompanyId); else newSettingsCompany();
    toast('Company deleted', 'success');
    return;
  }

  try {
    await API('DELETE', `/api/companies/${deletingId}`);
    await loadCompanies();
  } catch {
    companies = companies.filter(c => c.id !== deletingId);
    localStorage.setItem('inv_companies', JSON.stringify(companies));
    renderDropdown('company');
    renderSettingsCompanyList();
  }
  if (selCompId === deletingId) {
    selCompId = null;
    ['s-name','s-addr','s-phone','s-email'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('chk-individual-disclaimer').checked = false;
  }
  settingsCompanyId = companies[0]?.id || null;
  if (settingsCompanyId) selectSettingsCompany(settingsCompanyId); else newSettingsCompany();
  toast('Company deleted', 'success');
}

function useSettingsCompanyOnInvoice(showToast = true) {
  const company = settingsCompanyId ? companies.find(c => c.id === settingsCompanyId) : collectSettingsCompany();
  if (!company || !company.name) { toast('Select or save a company first', 'error'); return; }
  if (showToast) {
    // v2 flow: create a fresh draft seeded with this company and open it.
    startNewInvoiceForCompany(company.id || settingsCompanyId);
    toast('Company loaded on a new draft', 'success');
    return;
  }
  // Internal silent caller (e.g., during save flows) — still write to
  // the legacy form fields so any in-progress legacy state is consistent.
  applyCompanyToInvoice(company);
  renderDropdown('company');
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (supabaseActive()) closeAuthModal();
    closePdfPreview();
    // Escape from any sub-route returns to Home (the new hub).
    const hash = location.hash || '';
    if (hash && hash !== '#/' && hash !== '#/home') {
      openHome();
    }
  }
});

// ── API helpers ────────────────────────────────────────────────────────────
const API = async (method, url, body) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    return r.json();
  } finally {
    clearTimeout(timer);
  }
};

function supabaseActive() {
  return !!(supabaseClient && supabaseUser);
}

function usernameToEmail(value) {
  const clean = String(value || '').trim().toLowerCase();
  if (!clean) return '';
  return clean.includes('@') ? clean : `${clean}@invoice.local`;
}

function authDisplayName() {
  const email = supabaseUser?.email || '';
  return email.endsWith('@invoice.local') ? email.replace('@invoice.local', '') : email;
}

function updateAuthUi() {
  const btn = document.getElementById('supabase-auth-btn');
  const signout = document.getElementById('supabase-signout-btn');
  if (!btn || !signout) return;

  btn.classList.toggle('online', supabaseActive());
  if (supabaseActive()) {
    document.body.classList.remove('auth-locked');
    // The .online green dot already signals "signed in" — show just the name.
    btn.textContent = authDisplayName();
    btn.title = `Signed in: ${authDisplayName()}`;
    signout.style.display = 'inline-flex';
    closeAuthModal(true);
  } else if (supabaseConfigured) {
    document.body.classList.add('auth-locked');
    btn.textContent = 'Sign in';
    btn.title = 'Sign in';
    signout.style.display = 'none';
    openAuthModal(true);
  } else {
    document.body.classList.remove('auth-locked');
    btn.textContent = 'Local data';
    btn.title = 'Using local data — sign in to sync';
    signout.style.display = 'none';
  }
}

async function initSupabaseAuth() {
  try {
    const config = await API('GET', '/api/supabase-config');
    supabaseConfigured = !!config.enabled;
    if (!supabaseConfigured) {
      updateAuthUi();
      return;
    }

    const module = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    supabaseClient = module.createClient(config.url, config.anon_key);
    const { data } = await supabaseClient.auth.getSession();
    supabaseUser = data?.session?.user || null;
    updateAuthUi();
    if (supabaseUser) await loadRemoteDocumentSettings();

    supabaseClient.auth.onAuthStateChange(async (_event, session) => {
      supabaseUser = session?.user || null;
      updateAuthUi();
      if (supabaseUser) {
        await loadRemoteDocumentSettings();
        if (!rowCount) addRow();
        await loadCompanies();
        await loadCustomers();
        await loadInvoices();   // pull the signed-in user's invoices
        routeView();            // re-render the active view with loaded data
      } else {
        companies = [];
        customers = [];
        invoices = [];
        selCompId = null;
        selCustId = null;
        renderDropdown('company');
        renderDropdown('customer');
        routeView();
      }
    });
  } catch (err) {
    supabaseConfigured = false;
    supabaseClient = null;
    supabaseUser = null;
    updateAuthUi();
  }
}

function openAuthModal() {
  if (!supabaseConfigured) {
    toast('Add data/supabase_config.json to enable Supabase login', 'error');
    return;
  }
  const modal = document.getElementById('auth-modal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  setTimeout(() => document.getElementById('auth-username')?.focus(), 30);
}

function closeAuthModal(force = false) {
  if (!force && !supabaseActive()) return;
  const modal = document.getElementById('auth-modal');
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

function closeAuthOnBackdrop(event) {
  if (event.target.id === 'auth-modal' && supabaseActive()) closeAuthModal();
}

async function signInSupabase() {
  if (!supabaseClient) {
    toast('Supabase is not configured yet', 'error');
    return;
  }
  const btn = document.getElementById('auth-login-btn');
  const previous = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Signing in...';
  try {
    const email = usernameToEmail(document.getElementById('auth-username').value);
    const password = document.getElementById('auth-password').value;
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    supabaseUser = data.user;
    updateAuthUi();
    closeAuthModal(true);
    await loadRemoteDocumentSettings();
    if (!rowCount) addRow();
    await loadCompanies();
    await loadCustomers();
    await loadInvoices();   // pull the signed-in user's invoices
    routeView();            // re-render the active view with loaded data
    toast('Signed in', 'success');
  } catch (err) {
    toast(err.message || 'Sign in failed', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = previous;
  }
}

async function signOutSupabase() {
  if (supabaseClient) await supabaseClient.auth.signOut();
  supabaseUser = null;
  companies = [];
  customers = [];
  selCompId = null;
  selCustId = null;
  updateAuthUi();
  loadDocumentSettings();
  renderDropdown('company');
  renderDropdown('customer');
  renderSettingsCompanyList();
  toast('Signed out', 'success');
}

const ITEM_HISTORY_KEY = 'inv_item_history';
const ITEM_HISTORY_MAX = 80;

function getItemHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(ITEM_HISTORY_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(s => typeof s === 'string' && s.trim()) : [];
  } catch {
    return [];
  }
}

function renderItemHistoryDatalist() {
  const dl = document.getElementById('item-desc-history');
  if (!dl) return;
  const opts = getItemHistory().map(desc => {
    const v = desc.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<option value="${v}">`;
  });
  dl.innerHTML = opts.join('');
}

function rememberItems(items) {
  if (!Array.isArray(items) || !items.length) return;
  const fresh = items.map(it => (it && it.description ? String(it.description).trim() : '')).filter(Boolean);
  if (!fresh.length) return;
  const merged = [...fresh, ...getItemHistory()];
  const seen = new Set();
  const out = [];
  for (const desc of merged) {
    const key = desc.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(desc);
    if (out.length >= ITEM_HISTORY_MAX) break;
  }
  localStorage.setItem(ITEM_HISTORY_KEY, JSON.stringify(out));
  renderItemHistoryDatalist();
}

// Derive the next invoice number from the invoices table — single source of
// truth. With year-prefix enabled, we only look at THIS year's records so the
// sequence resets to 001 on Jan 1. Without it, look at the global max.
function computeNextInvoiceNumber() {
  const list = Array.isArray(invoices) ? invoices : [];
  const yearPrefix = isYearPrefixEnabled();
  const currentYear = new Date().getFullYear();
  let maxSeq = 0;
  let lastPrefix = 'INV';
  for (const inv of list) {
    const num = String(inv?.number || inv?.payload?.invoice_number || '').trim();
    if (!num) continue;
    const m = num.match(/^(.*?)(?:-(\d{4}))?-?(\d+)$/);
    if (!m) continue;
    const head = (m[1] || 'INV').replace(/-+$/, '') || 'INV';
    const storedYear = m[2] ? parseInt(m[2], 10) : null;
    const seq = parseInt(m[3], 10) || 0;
    if (yearPrefix && storedYear !== currentYear) continue;
    lastPrefix = head;
    if (seq > maxSeq) maxSeq = seq;
  }
  const nextSeq = maxSeq + 1;
  if (yearPrefix) {
    return `${lastPrefix}-${currentYear}-${String(nextSeq).padStart(3, '0')}`;
  }
  return `${lastPrefix}-${String(nextSeq).padStart(3, '0')}`;
}

async function loadInvoiceNumber() {
  // Try to derive from the in-memory invoices list first — server-authoritative
  // computation that ignores any stale localStorage counter.
  if (Array.isArray(invoices) && invoices.length > 0) {
    setInvoiceNumber(computeNextInvoiceNumber());
    return;
  }
  // No invoices loaded yet (boot path, or no records). Fall back to the
  // cached number, then the Flask counter, then INV-001. Once invoices
  // load, callers should call computeNextInvoiceNumber() again.
  const cached = localStorage.getItem('inv_next_number');
  if (cached) {
    setInvoiceNumber(cached);
    return;
  }
  try {
    const r = await API('GET', '/api/invoice-number');
    setInvoiceNumber(r.invoice_number || 'INV-001');
  } catch {
    setInvoiceNumber('INV-001');
  }
}

function setInvoiceNumber(value) {
  const next = applyYearPrefixIfNeeded(value || 'INV-001');
  document.getElementById('inv-num').value = next;
  document.getElementById('inv-counter').textContent = next;
  localStorage.setItem('inv_next_number', next);
  // If we were bound to a saved record, but the number on screen no longer
  // matches that record's number, the next "Generate" should write a new
  // record — not patch the previous one with someone else's data. (This
  // happens right after a PDF gen, when the form auto-advances to the next
  // number.)
  if (editor.mode === 'editing' && editor.boundNumber && next !== editor.boundNumber) {
    setEditorMode('new');
  }
}

function normalizeCompany(company) {
  return {
    ...company,
    individual_disclaimer: !!company.individual_disclaimer,
  };
}

// ── Companies ──────────────────────────────────────────────────────────────
async function loadCompanies() {
  if (supabaseActive()) {
    const { data, error } = await supabaseClient
      .from('companies')
      .select('id,name,address,phone,email,individual_disclaimer')
      .order('created_at', { ascending: true });
    if (error) {
      toast(error.message || 'Could not load companies', 'error');
      companies = [];
    } else {
      companies = (data || []).map(normalizeCompany);
    }
    renderDropdown('company');
    renderSettingsCompanyList();
    renderIssueCompanyOptions();
    return;
  }

  try {
    companies = (await API('GET', '/api/companies')).map(normalizeCompany);
    renderDropdown('company');
    renderSettingsCompanyList();
    renderIssueCompanyOptions();
  } catch { /* server may not be running, use localStorage fallback */
    const stored = localStorage.getItem('inv_companies');
    companies = stored ? JSON.parse(stored).map(normalizeCompany) : [];
    renderDropdown('company');
    renderSettingsCompanyList();
    renderIssueCompanyOptions();
  }
}
// NOTE: loadCompanies intentionally does NOT auto-apply companies[0] to the
// editor anymore. In the draft model the seller/company comes from the draft
// record (restored by applyPayloadToForm + bindEditorToDraft) or the
// #issue-company selector, and the default for brand-new drafts is the
// remembered last company (lastCompanySeed). Auto-applying companies[0] on
// every boot/sign-in clobbered "Individual" drafts and overwrote the
// remembered choice via rememberLastCompany — the company-selection bug.

function applyCompanyToInvoice(company) {
  if (!company) return;
  selCompId = company.id || null;
  document.getElementById('s-name').value = company.name || '';
  document.getElementById('s-addr').value = company.address || '';
  document.getElementById('s-phone').value = company.phone || '';
  document.getElementById('s-email').value = company.email || '';
  document.getElementById('chk-individual-disclaimer').checked = !!company.individual_disclaimer;
  rememberLastCompany(company.id);
}

// ── Company selection persistence ───────────────────────────────────────────
// Remember the last company the user invoiced under, so new blank invoices
// default to it instead of forcing a re-pick every time. The "Individual /
// no company" flow explicitly clears this (passes no company), so it is
// never auto-reapplied there.
const LAST_COMPANY_KEY = 'inv_last_company';
function rememberLastCompany(id) {
  try {
    if (id) localStorage.setItem(LAST_COMPANY_KEY, id);
    else localStorage.removeItem(LAST_COMPANY_KEY);
  } catch {}
}
function getLastCompany() {
  let id; try { id = localStorage.getItem(LAST_COMPANY_KEY); } catch { id = null; }
  if (!id) return null;
  return (companies || []).find(c => c.id === id) || null;
}
// Returns a draft seed ({seller, company_id}) for the remembered company,
// or {} when none is remembered / it no longer exists.
function lastCompanySeed() {
  const c = getLastCompany();
  if (!c) return {};
  return {
    company_id: c.id,
    seller: { name: c.name || '', address: c.address || '', phone: c.phone || '', email: c.email || '' },
    individual_disclaimer: !!c.individual_disclaimer,
  };
}
// Create a fresh draft pre-seeded with the last-used company, and open it.
// Used by the generic "+ New invoice / + New draft" entry points.
function newDraftWithLastCompany() {
  const d = newDraft(lastCompanySeed());
  openDraft(d.local_id);
}

async function saveCompany() {
  const name  = document.getElementById('s-name').value.trim();
  if (!name) { toast('Enter a company name first', 'error'); return; }
  const comp = {
    id:      selCompId || undefined,
    name,
    address: document.getElementById('s-addr').value.trim(),
    phone:   document.getElementById('s-phone').value.trim(),
    email:   document.getElementById('s-email').value.trim(),
    individual_disclaimer: document.getElementById('chk-individual-disclaimer').checked,
  };
  if (supabaseActive()) {
    const payload = {
      name: comp.name,
      address: comp.address,
      phone: comp.phone,
      email: comp.email,
      individual_disclaimer: comp.individual_disclaimer,
    };
    const query = comp.id
      ? supabaseClient.from('companies').update(payload).eq('id', comp.id).select('id').single()
      : supabaseClient.from('companies').insert({ ...payload, user_id: supabaseUser.id }).select('id').single();
    const { data, error } = await query;
    if (error) {
      toast(error.message || 'Company save failed', 'error');
      return;
    }
    selCompId = data.id;
    await loadCompanies();
    toast('Company saved', 'success');
    return;
  }

  try {
    const r = await API('POST', '/api/companies', comp);
    selCompId = r.id;
    await loadCompanies();
    toast('Company saved ✓', 'success');
  } catch {
    // localStorage fallback
    if (!comp.id) comp.id = 'c' + Date.now();
    const idx = companies.findIndex(c => c.id === comp.id);
    if (idx >= 0) companies[idx] = comp; else companies.push(comp);
    localStorage.setItem('inv_companies', JSON.stringify(companies));
    selCompId = comp.id;
    renderDropdown('company');
    renderSettingsCompanyList();
    toast('Company saved ✓', 'success');
  }
}

async function deleteCompany() {
  if (!selCompId) { toast('Select a saved company first', 'error'); return; }
  const deletingId = selCompId;
  if (supabaseActive()) {
    const { error } = await supabaseClient.from('companies').delete().eq('id', deletingId);
    if (error) {
      toast(error.message || 'Company delete failed', 'error');
      return;
    }
    await loadCompanies();
    if (settingsCompanyId === deletingId) settingsCompanyId = null;
    selCompId = null;
    ['s-name','s-addr','s-phone','s-email'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('chk-individual-disclaimer').checked = false;
    toast('Company deleted', 'success');
    return;
  }

  try {
    await API('DELETE', `/api/companies/${deletingId}`);
    await loadCompanies();
  } catch {
    companies = companies.filter(c => c.id !== deletingId);
    localStorage.setItem('inv_companies', JSON.stringify(companies));
    renderDropdown('company');
    renderSettingsCompanyList();
  }
  if (settingsCompanyId === deletingId) settingsCompanyId = null;
  selCompId = null;
  ['s-name','s-addr','s-phone','s-email'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('chk-individual-disclaimer').checked = false;
  toast('Company deleted', 'success');
}

// ── Customers ──────────────────────────────────────────────────────────────
async function loadCustomers() {
  if (supabaseActive()) {
    const { data, error } = await supabaseClient
      .from('customers')
      .select('id,name,address,phone,email,net_terms_days')
      .order('created_at', { ascending: true });
    if (error) {
      toast(error.message || 'Could not load clients', 'error');
      customers = [];
    } else {
      customers = data || [];
    }
    renderDropdown('customer');
    return;
  }

  try {
    customers = await API('GET', '/api/customers');
    renderDropdown('customer');
  } catch {
    const stored = localStorage.getItem('inv_customers');
    customers = stored ? JSON.parse(stored) : [];
    renderDropdown('customer');
  }
}

async function saveCustomer() {
  const name = document.getElementById('b-name').value.trim();
  if (!name) { toast('Enter a client name first', 'error'); return; }
  const netInput = document.getElementById('b-net-terms')?.value;
  const netTermsDays = Math.max(0, parseInt(netInput, 10) || 30);
  const cust = {
    id:      selCustId || undefined,
    name,
    address: document.getElementById('b-addr').value.trim(),
    phone:   document.getElementById('b-phone').value.trim(),
    email:   document.getElementById('b-email').value.trim(),
    net_terms_days: netTermsDays,
  };
  if (supabaseActive()) {
    const payload = {
      name: cust.name,
      address: cust.address,
      phone: cust.phone,
      email: cust.email,
      net_terms_days: cust.net_terms_days,
    };
    const query = cust.id
      ? supabaseClient.from('customers').update(payload).eq('id', cust.id).select('id').single()
      : supabaseClient.from('customers').insert({ ...payload, user_id: supabaseUser.id }).select('id').single();
    const { data, error } = await query;
    if (error) {
      toast(error.message || 'Client save failed', 'error');
      return;
    }
    selCustId = data.id;
    await loadCustomers();
    toast('Client saved', 'success');
    return;
  }

  try {
    const r = await API('POST', '/api/customers', cust);
    selCustId = r.id;
    await loadCustomers();
    toast('Client saved ✓', 'success');
  } catch {
    if (!cust.id) cust.id = 'cu' + Date.now();
    const idx = customers.findIndex(c => c.id === cust.id);
    if (idx >= 0) customers[idx] = cust; else customers.push(cust);
    localStorage.setItem('inv_customers', JSON.stringify(customers));
    selCustId = cust.id;
    renderDropdown('customer');
    toast('Client saved ✓', 'success');
  }
}

async function deleteCustomer() {
  if (!selCustId) { toast('Select a saved client first', 'error'); return; }
  if (supabaseActive()) {
    const { error } = await supabaseClient.from('customers').delete().eq('id', selCustId);
    if (error) {
      toast(error.message || 'Client delete failed', 'error');
      return;
    }
    await loadCustomers();
    selCustId = null;
    ['b-name','b-addr','b-phone','b-email'].forEach(id => document.getElementById(id).value = '');
    const nt0 = document.getElementById('b-net-terms'); if (nt0) nt0.value = 30;
    toast('Client deleted', 'success');
    return;
  }

  try {
    await API('DELETE', `/api/customers/${selCustId}`);
    await loadCustomers();
  } catch {
    customers = customers.filter(c => c.id !== selCustId);
    localStorage.setItem('inv_customers', JSON.stringify(customers));
    renderDropdown('customer');
  }
  selCustId = null;
  ['b-name','b-addr','b-phone','b-email'].forEach(id => document.getElementById(id).value = '');
  toast('Client deleted', 'success');
}

// ── Invoices (persistence layer) ───────────────────────────────────────────
// Mirrors the customers/companies dual-mode shape: Supabase when signed in,
// local JSON / localStorage otherwise. All callers use these helpers — never
// touch supabaseClient.from('invoices') directly elsewhere.

const INVOICES_LS = 'inv_invoices_v1';
function _loadInvoicesLS() {
  try { const r = localStorage.getItem(INVOICES_LS); return r ? JSON.parse(r) : []; } catch { return []; }
}
function _saveInvoicesLS(list) {
  try { localStorage.setItem(INVOICES_LS, JSON.stringify(list)); } catch {}
}

async function loadInvoices() {
  if (supabaseActive()) {
    const { data, error } = await supabaseClient
      .from('invoices')
      .select('*')
      .order('date', { ascending: false });
    if (error) {
      // Most likely cause: 2026-05-28-invoices.sql hasn't been run yet.
      console.warn('Invoices load skipped:', error.message || error);
      invoices = _loadInvoicesLS();   // fall back to local cache
      return;
    }
    invoices = data || [];
    return;
  }
  try {
    invoices = await API('GET', '/api/invoices');
    _saveInvoicesLS(invoices);   // mirror server → localStorage so offline still reads
  } catch {
    invoices = _loadInvoicesLS();
  }
}

async function saveInvoice(record) {
  // Used after PDF generation. record carries number, status, date, etc.
  const nowIso = new Date().toISOString();
  const base = {
    number:   record.number,
    status:   record.status || 'draft',
    date:     record.date,
    due_date: record.due_date || null,
    customer_id: record.customer_id || null,
    company_id:  record.company_id  || null,
    buyer:    record.buyer || {},
    seller:   record.seller || {},
    total:    Number(record.total) || 0,
    currency: record.currency || 'USD',
    payload:  record.payload || {},
    history:  record.history || [],
  };
  if (supabaseActive()) {
    const { data, error } = await supabaseClient
      .from('invoices')
      .insert({ ...base, user_id: supabaseUser.id })
      .select('*')
      .single();
    if (error) {
      console.warn('Invoice save skipped:', error.message || error);
      // Fall back to localStorage so the user doesn't lose the record.
      const fallback = { ...base, id: 'iv' + Date.now(), created_at: nowIso };
      invoices.unshift(fallback);
      _saveInvoicesLS(invoices);
      return fallback;
    }
    invoices.unshift(data);
    return data;
  }
  try {
    const r = await API('POST', '/api/invoices', base);
    const saved = r.invoice || { ...base, id: r.id, created_at: nowIso };
    invoices.unshift(saved);
    _saveInvoicesLS(invoices);
    return saved;
  } catch {
    const saved = { ...base, id: 'iv' + Date.now(), created_at: nowIso };
    invoices.unshift(saved);
    _saveInvoicesLS(invoices);
    return saved;
  }
}

async function patchInvoice(id, fields) {
  // Apply the patch optimistically, then push to backend. On any failure,
  // re-load to reconcile.
  const idx = invoices.findIndex(r => r.id === id);
  if (idx < 0) return null;
  const before = { ...invoices[idx] };
  const hist = Array.isArray(before.history) ? before.history.slice() : [];
  if (fields.status && fields.status !== before.status) {
    hist.push({ at: new Date().toISOString(), from: before.status, to: fields.status });
    if (fields.status === 'paid' && !fields.paid_at)  fields.paid_at = new Date().toISOString();
    if (fields.status === 'issued' && !fields.sent_at) fields.sent_at = new Date().toISOString();
  }
  invoices[idx] = { ...before, ...fields, history: hist };
  _saveInvoicesLS(invoices);

  if (supabaseActive()) {
    // Same schema-cache tolerance as insertInvoiceRow: if the DB
    // complains about an optional column not in its cache (migration
    // not applied / cache stale), drop just that column and retry so
    // the rest of the patch (e.g. status='void') still lands. The
    // optimistic in-memory update already reflects the full intent.
    const OPTIONAL_COLUMNS = ['superseded_by', 'company_id', 'sent_at'];
    let payload = { ...fields, history: hist };
    let succeeded = false;
    for (let attempt = 0; attempt < OPTIONAL_COLUMNS.length + 1; attempt++) {
      const { error } = await supabaseClient
        .from('invoices')
        .update(payload)
        .eq('id', id);
      if (!error) { succeeded = true; break; }
      const m = String(error.message || '').match(/'([a-z_]+)' column/i);
      const offending = m ? m[1] : null;
      if (offending && OPTIONAL_COLUMNS.includes(offending) && offending in payload) {
        delete payload[offending];
        continue;
      }
      console.warn('Invoice patch failed:', error.message);
      await loadInvoices();
      break;
    }
    void succeeded;
  } else {
    try { await API('PATCH', '/api/invoices/' + encodeURIComponent(id), { ...fields, history: hist }); }
    catch { /* localStorage already updated */ }
  }
  return invoices[idx];
}

async function deleteInvoiceRecord(id) {
  invoices = invoices.filter(r => r.id !== id);
  _saveInvoicesLS(invoices);
  if (supabaseActive()) {
    const { error } = await supabaseClient.from('invoices').delete().eq('id', id);
    if (error) { console.warn('Invoice delete failed:', error.message); await loadInvoices(); }
  } else {
    try { await API('DELETE', '/api/invoices/' + encodeURIComponent(id)); } catch {}
  }
}

// Auto-flip draft → issued on PDF generation (suggestion #3). User can opt
// out via the settings toggle.
function isAutoIssueEnabled() {
  return localStorage.getItem('inv_auto_issue') !== '0';   // default ON
}

// Persistence wrapper called from generateInvoice success paths. Either
// inserts a new record or patches the one we're currently editing.
async function persistGeneratedInvoice(generatedNumber) {
  if (isAutoIssueEnabled() && currentInvoiceStatus === 'draft') {
    currentInvoiceStatus = 'issued';
    if (typeof renderInvoiceStatus === 'function') renderInvoiceStatus();
  }
  const record = buildInvoiceRecordFromForm(generatedNumber);
  if (editor.mode === 'editing' && editor.invoiceId) {
    await patchInvoice(editor.invoiceId, {
      status:   record.status,
      total:    record.total,
      buyer:    record.buyer,
      seller:   record.seller,
      currency: record.currency,
      due_date: record.due_date,
      payload:  record.payload,
    });
    editor.dirty = false;
    if (typeof renderEditingSaveButton === 'function') renderEditingSaveButton();
  } else {
    const saved = await saveInvoice(record);
    if (saved?.id) {
      setEditorMode('editing', saved);
    }
  }
}

// "Save changes" button in the editing banner. Patches the bound record
// with the current form payload — no PDF generation, no number bump.
async function saveEditingChanges() {
  if (editor.mode !== 'editing' || !editor.invoiceId) return;
  if (!editor.dirty) return;
  const record = buildInvoiceRecordFromForm(editor.boundNumber);
  await patchInvoice(editor.invoiceId, {
    status:   record.status,
    total:    record.total,
    buyer:    record.buyer,
    seller:   record.seller,
    currency: record.currency,
    due_date: record.due_date,
    payload:  record.payload,
  });
  editor.dirty = false;
  if (typeof renderEditingSaveButton === 'function') renderEditingSaveButton();
  toast(`Saved changes to ${editor.boundNumber}`, 'success');
}

// Build the canonical invoice record from the current editor state.
// Called after a successful PDF generation.
function buildInvoiceRecordFromForm(generatedNumber) {
  const payload = collectData();
  // Use the number we just generated under (server may have advanced
  // next_invoice_number afterward — we want to record the one printed).
  const number = generatedNumber || payload.invoice_number;
  // The grand total from the live UI.
  const totalText = (document.getElementById('t-grand')?.textContent || '').replace(/[^0-9.\-]/g, '');
  const total = parseFloat(totalText) || 0;
  return {
    number,
    status:      currentInvoiceStatus || 'draft',
    date:        payload.date,
    due_date:    payload.due_date,
    customer_id: selCustId || null,
    company_id:  selCompId || null,
    buyer:       payload.buyer,
    seller:      payload.seller,
    total,
    currency:    payload.currency,
    payload,
    history:     [],
  };
}

// ── Dropdown rendering ─────────────────────────────────────────────────────
function renderDropdown(type) {
  const isComp = type === 'company';
  const list   = isComp ? companies : customers;
  const ddId   = isComp ? 'comp-dropdown' : 'cust-dropdown';
  const dd     = document.getElementById(ddId);
  const filter = (isComp ? document.getElementById('s-name') : document.getElementById('b-name')).value.toLowerCase();

  const filtered = list.filter(item =>
    !filter || item.name.toLowerCase().includes(filter));

  dd.innerHTML = '';
  if (!filtered.length) {
    dd.innerHTML = `<div class="dropdown-item" style="color:var(--text3);font-size:12px">No saved ${isComp?'companies':'clients'}</div>`;
  } else {
    filtered.forEach(item => {
      const div = document.createElement('div');
      div.className = 'dropdown-item';
      div.innerHTML = `
        <div>
          <div class="di-name">${item.name}</div>
          <div class="di-sub">${[item.phone, item.email].filter(Boolean).join(' · ') || '—'}</div>
        </div>
        <span class="di-del" title="Delete" onclick="event.stopPropagation();quickDelete('${type}','${item.id}')">×</span>`;
      div.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('di-del')) return;
        selectItem(type, item);
      });
      dd.appendChild(div);
    });
  }
}

function selectItem(type, item) {
  if (type === 'company') {
    applyCompanyToInvoice(item);
    closeDropdown('company');
  } else {
    selCustId = item.id;
    document.getElementById('b-name').value  = item.name    || '';
    document.getElementById('b-addr').value  = item.address || '';
    document.getElementById('b-phone').value = item.phone   || '';
    document.getElementById('b-email').value = item.email   || '';
    const nt = document.getElementById('b-net-terms');
    if (nt) nt.value = (item.net_terms_days ?? 30);
    closeDropdown('customer');
    renderInvoiceStatus();
  }
}

async function quickDelete(type, id) {
  if (type === 'company') {
    if (supabaseActive()) {
      const { error } = await supabaseClient.from('companies').delete().eq('id', id);
      if (error) { toast(error.message || 'Company delete failed', 'error'); return; }
      await loadCompanies();
      if (selCompId === id) {
        selCompId = null;
        ['s-name','s-addr','s-phone','s-email'].forEach(fieldId => document.getElementById(fieldId).value = '');
        document.getElementById('chk-individual-disclaimer').checked = false;
      }
      if (settingsCompanyId === id) settingsCompanyId = null;
      renderDropdown('company');
      renderSettingsCompanyList();
      return;
    }
    companies = companies.filter(c => c.id !== id);
    localStorage.setItem('inv_companies', JSON.stringify(companies));
    try { await API('DELETE', `/api/companies/${id}`); } catch {}
    if (selCompId === id) {
      selCompId = null;
      ['s-name','s-addr','s-phone','s-email'].forEach(fieldId => document.getElementById(fieldId).value = '');
      document.getElementById('chk-individual-disclaimer').checked = false;
    }
    if (settingsCompanyId === id) settingsCompanyId = null;
    renderDropdown('company');
    renderSettingsCompanyList();
  } else {
    if (supabaseActive()) {
      const { error } = await supabaseClient.from('customers').delete().eq('id', id);
      if (error) { toast(error.message || 'Client delete failed', 'error'); return; }
      await loadCustomers();
      if (selCustId === id) selCustId = null;
      renderDropdown('customer');
      return;
    }
    customers = customers.filter(c => c.id !== id);
    localStorage.setItem('inv_customers', JSON.stringify(customers));
    try { await API('DELETE', `/api/customers/${id}`); } catch {}
    if (selCustId === id) selCustId = null;
    renderDropdown('customer');
  }
}

function onComboInput(type) {
  if (type === 'company') selCompId = null;
  else selCustId = null;
  renderDropdown(type);
  openDropdown(type);
}

function openDropdown(type) {
  document.getElementById(type === 'company' ? 'comp-dropdown' : 'cust-dropdown').classList.add('open');
  renderDropdown(type);
}

function closeDropdown(type) {
  document.getElementById(type === 'company' ? 'comp-dropdown' : 'cust-dropdown').classList.remove('open');
}

function closeDropdownDelay(type) {
  setTimeout(() => closeDropdown(type), 180);
}

// ── Items ──────────────────────────────────────────────────────────────────
function addRow() {
  rowCount++;
  const n  = rowCount;
  const tr = document.createElement('tr');
  tr.id    = 'row-' + n;
  tr.innerHTML = `
    <td style="text-align:center;color:var(--text3);font-size:12px;padding:4px 6px">${n}</td>
    <td><input type="text" placeholder="Item description / وصف البند" id="desc-${n}" list="item-desc-history" autocomplete="off" oninput="recalc()"></td>
    <td class="r"><input type="number" value="1" min="0" step="1"    id="qty-${n}"  oninput="recalc()" style="width:70px"></td>
    <td class="r"><input type="number" value="0" min="0" step="0.01" id="up-${n}"   oninput="recalc()" style="width:90px"></td>
    <td class="r discount-col"><input type="number" value="0" min="0" max="100"   id="disc-${n}" oninput="recalc()" style="width:60px"></td>
    <td class="num money-cell" id="lt-${n}">
      <span class="money-symbol">${currencyMark(document.getElementById('currency')?.value || 'USD')}</span>
      <span class="money-value">0.00</span>
    </td>
    <td><button class="del-row" onclick="delRow(${n})" title="Remove">×</button></td>`;
  document.getElementById('items-body').appendChild(tr);
  recalc();
}

function delRow(n) {
  const el = document.getElementById('row-' + n);
  if (el) el.remove();
  recalc();
}

// ── Calculations ───────────────────────────────────────────────────────────
const ONES_EN = ['','one','two','three','four','five','six','seven','eight','nine','ten',
  'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const TENS_EN = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
const ONES_AR = ['','واحد','اثنان','ثلاثة','أربعة','خمسة','ستة','سبعة','ثمانية','تسعة','عشرة',
  'أحد عشر','اثنا عشر','ثلاثة عشر','أربعة عشر','خمسة عشر','ستة عشر','سبعة عشر','ثمانية عشر','تسعة عشر'];
const TENS_AR = ['','','عشرون','ثلاثون','أربعون','خمسون','ستون','سبعون','ثمانون','تسعون'];

function n2wEn(n) {
  n = Math.round(n);
  if (n===0) return 'zero';
  if (n<20)  return ONES_EN[n];
  if (n<100) return TENS_EN[Math.floor(n/10)] + (n%10 ? ' '+ONES_EN[n%10] : '');
  if (n<1000) return ONES_EN[Math.floor(n/100)] + ' hundred' + (n%100 ? ' '+n2wEn(n%100) : '');
  if (n<1e6)  return n2wEn(Math.floor(n/1000)) + ' thousand' + (n%1000 ? ' '+n2wEn(n%1000) : '');
  return n2wEn(Math.floor(n/1e6)) + ' million' + (n%1e6 ? ' '+n2wEn(n%1e6) : '');
}
function n2wAr(n) {
  n = Math.round(n);
  if (n===0) return 'صفر';
  if (n<20)  return ONES_AR[n];
  if (n<100) return TENS_AR[Math.floor(n/10)] + (n%10 ? ' و'+ONES_AR[n%10] : '');
  if (n<1000) return ONES_AR[Math.floor(n/100)] + ' مئة' + (n%100 ? ' و'+n2wAr(n%100) : '');
  if (n<1e6)  return n2wAr(Math.floor(n/1000)) + ' ألف' + (n%1000 ? ' و'+n2wAr(n%1000) : '');
  return n2wAr(Math.floor(n/1e6)) + ' مليون' + (n%1e6 ? ' و'+n2wAr(n%1e6) : '');
}

const CUR_EN = { USD:{m:'US Dollars',f:'Cents'}, LBP:{m:'Lebanese Pounds',f:'Piastres'} };
const CUR_AR = { USD:{m:'دولار أمريكي',f:'سنت'}, LBP:{m:'ليرة لبنانية',f:'قرش'} };

function amountWords(amount, cur) {
  const intP = Math.floor(amount), decP = Math.round((amount-intP)*100);
  const en = CUR_EN[cur]||{m:cur,f:'Cents'}, ar = CUR_AR[cur]||{m:cur,f:'سنت'};
  let enW = n2wEn(intP)+' '+en.m+(decP>0?' and '+n2wEn(decP)+' '+en.f:'');
  enW = enW.charAt(0).toUpperCase()+enW.slice(1)+' Only';
  let arW = n2wAr(intP)+' '+ar.m+(decP>0?' و'+n2wAr(decP)+' '+ar.f:'');
  arW += ' فقط';
  return { en: enW, ar: arW };
}

// ── Invoice status workflow ────────────────────────────────────────────────
// Statuses on the current invoice:
//   draft   → being prepared, before PDF is sent. Default.
//   issued  → PDF generated/sent. No badge unless past due.
//   paid    → customer paid (paid_date set).
// Derived state:
//   overdue → status='issued' AND today > (issue_date + customer.net_terms_days).
// The buyer's net-terms field on the form is the source of truth for the
// allowance (per-customer net-30/60/etc.).
function netTermsDaysForCurrent() {
  const v = parseInt(document.getElementById('b-net-terms')?.value, 10);
  return Number.isFinite(v) && v >= 0 ? v : 30;
}
function isOverdue() {
  if (currentInvoiceStatus !== 'issued') return false;
  const issued = document.getElementById('inv-date')?.value;
  if (!issued) return false;
  const issuedDate = new Date(issued + 'T00:00:00');
  if (isNaN(issuedDate)) return false;
  const dueDate = new Date(issuedDate.getTime() + netTermsDaysForCurrent() * 864e5);
  return new Date() > dueDate;
}
function effectiveStatus() {
  if (currentInvoiceStatus === 'paid') return 'paid';
  if (isOverdue()) return 'overdue';
  return currentInvoiceStatus || 'draft';
}
function renderInvoiceStatus() {
  const badge = document.getElementById('inv-status-badge');
  const meta  = document.getElementById('inv-status-meta');
  if (!badge) return;
  const eff = effectiveStatus();
  badge.dataset.status = eff;
  badge.textContent = eff.charAt(0).toUpperCase() + eff.slice(1);
  // Meta line: "Paid 2026-05-12" or "Due 2026-06-15" or empty.
  let metaText = '';
  if (eff === 'paid' && currentInvoicePaidDate) {
    metaText = `Paid ${currentInvoicePaidDate}`;
  } else if (currentInvoiceStatus === 'issued') {
    const issued = document.getElementById('inv-date')?.value;
    if (issued) {
      const dueDate = new Date(new Date(issued + 'T00:00:00').getTime() + netTermsDaysForCurrent() * 864e5);
      if (!isNaN(dueDate)) metaText = (eff === 'overdue' ? 'Was due ' : 'Due ') + dueDate.toISOString().slice(0, 10);
    }
  }
  if (meta) meta.textContent = metaText;
  // Highlight the matching action button (visual reflection of stored state,
  // not the derived overdue — overdue is informational, not a settable state).
  document.querySelectorAll('#invoice-status-section .status-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.status === currentInvoiceStatus);
  });
}
function setInvoiceStatus(next) {
  const valid = ['draft', 'issued', 'paid'];
  if (!valid.includes(next)) return;
  currentInvoiceStatus = next;
  currentInvoicePaidDate = next === 'paid' ? new Date().toISOString().slice(0, 10) : null;
  renderInvoiceStatus();
  if (editor.mode === 'editing') {
    editor.dirty = true;
    if (typeof renderEditingSaveButton === 'function') renderEditingSaveButton();
  } else {
    saveDraft();
  }
}

function fmtNum(n) { return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function currencyMark(cur) { return cur === 'USD' ? '$' : 'LBP'; }
function setMoneyCell(el, cur, amount) {
  if (!el) return;
  el.innerHTML = `<span class="money-symbol">${currencyMark(cur)}</span><span class="money-value">${fmtNum(amount)}</span>`;
}

// Read the invoice-wide discount widget state. Returns { enabled, type, value, amount }
// where `amount` is the realized discount in currency units, clamped to baseAfterLines.
function readInvoiceDiscount(baseAfterLines) {
  const enabled = document.getElementById('chk-invoice-disc')?.checked === true;
  if (!enabled) return { enabled: false, type: 'pct', value: 0, amount: 0 };
  const type  = document.getElementById('invoice-disc-type')?.value === 'fixed' ? 'fixed' : 'pct';
  const value = Math.max(0, parseFloat(document.getElementById('invoice-disc-value')?.value) || 0);
  let amount  = type === 'fixed' ? value : baseAfterLines * (value / 100);
  // Never let the invoice discount push the total below zero.
  if (amount > baseAfterLines) amount = baseAfterLines;
  return { enabled: true, type, value, amount };
}

function toggleInvoiceDiscount() {
  const on = document.getElementById('chk-invoice-disc').checked;
  const ctrls = document.getElementById('invoice-disc-controls');
  if (on) ctrls.removeAttribute('hidden');
  else    ctrls.setAttribute('hidden', '');
  recalc();
}

function recalc() {
  const cur     = document.getElementById('currency').value;
  const vatPct  = parseFloat(document.getElementById('vat-pct').value) || 0;
  const includeDiscount = document.getElementById('chk-discount').checked;
  const rows    = document.querySelectorAll('#items-body tr');

  let sub = 0, totalDisc = 0;
  rows.forEach(tr => {
    const id = tr.id.replace('row-','');
    const q  = parseFloat(document.getElementById('qty-'+id)?.value)  || 0;
    const u  = parseFloat(document.getElementById('up-'+id)?.value)   || 0;
    const d  = includeDiscount ? (parseFloat(document.getElementById('disc-'+id)?.value) || 0) : 0;
    const gross = q * u;
    const disc  = gross * (d/100);
    const net   = gross - disc;
    sub       += gross;
    totalDisc += disc;
    setMoneyCell(document.getElementById('lt-'+id), cur, net);
  });

  const baseAfterLines = sub - totalDisc;
  const invDisc        = readInvoiceDiscount(baseAfterLines);
  const taxableBase    = baseAfterLines - invDisc.amount;
  const vatAmt         = taxableBase * (vatPct/100);
  const grand          = taxableBase + vatAmt;

  document.getElementById('t-sub').textContent   = cur + ' ' + fmtNum(sub);

  const discRow = document.getElementById('disc-row');
  if (includeDiscount && totalDisc > 0) {
    discRow.style.display = 'flex';
    document.getElementById('t-disc').textContent = '- ' + cur + ' ' + fmtNum(totalDisc);
  } else { discRow.style.display = 'none'; }

  const invDiscRow = document.getElementById('invoice-disc-row');
  if (invDisc.enabled && invDisc.amount > 0) {
    invDiscRow.style.display = 'flex';
    const suffix = invDisc.type === 'pct' ? ` (${invDisc.value}%)` : '';
    document.getElementById('t-invoice-disc-lbl').textContent = `Invoice discount${suffix} / خصم الفاتورة`;
    document.getElementById('t-invoice-disc').textContent     = '- ' + cur + ' ' + fmtNum(invDisc.amount);
  } else { invDiscRow.style.display = 'none'; }

  const vatRow = document.getElementById('vat-row');
  if (vatPct > 0) {
    vatRow.style.display = 'flex';
    document.getElementById('t-vat-lbl').textContent = `VAT (${vatPct}%) / ضريبة`;
    document.getElementById('t-vat').textContent     = cur + ' ' + fmtNum(vatAmt);
  } else { vatRow.style.display = 'none'; }

  document.getElementById('t-grand').textContent = cur + ' ' + fmtNum(grand);

  const w = amountWords(grand, cur);
  document.getElementById('w-en').textContent = w.en;
  document.getElementById('w-ar').textContent = w.ar;
  updateActionSummary();
  renderInvoiceStatus();
  // Editor autosave. In v2 draft-edit mode, write to the per-draft v2
  // slot. Otherwise fall through to the legacy v1 saveDraft.
  if (editingDraftId) writeEditingDraft();
  else saveDraft();
}

// ── Collect form data ──────────────────────────────────────────────────────
function collectData() {
  const rows  = document.querySelectorAll('#items-body tr');
  const items = [];
  const includeDiscount = document.getElementById('chk-discount').checked;
  rows.forEach(tr => {
    const id   = tr.id.replace('row-','');
    const desc = document.getElementById('desc-'+id)?.value.trim();
    const qty  = parseFloat(document.getElementById('qty-'+id)?.value)  || 0;
    const up   = parseFloat(document.getElementById('up-'+id)?.value)   || 0;
    const disc = includeDiscount ? (parseFloat(document.getElementById('disc-'+id)?.value) || 0) : 0;
    if (desc || qty || up) items.push({ description: desc||'', qty, unit_price: up, discount_pct: disc });
  });

  const hasDue = document.getElementById('chk-due').checked;
  const invDiscEnabled = document.getElementById('chk-invoice-disc')?.checked === true;
  const invDiscType    = document.getElementById('invoice-disc-type')?.value === 'fixed' ? 'fixed' : 'pct';
  const invDiscValue   = Math.max(0, parseFloat(document.getElementById('invoice-disc-value')?.value) || 0);

  return {
    invoice_number: document.getElementById('inv-num').value.trim() || 'INV-001',
    date:           document.getElementById('inv-date').value,
    due_date:       hasDue ? document.getElementById('inv-due').value : null,
    currency:       document.getElementById('currency').value,
    vat_pct:        parseFloat(document.getElementById('vat-pct').value) || 0,
    include_discount: includeDiscount,
    invoice_discount: invDiscEnabled
      ? { enabled: true, type: invDiscType, value: invDiscValue }
      : { enabled: false, type: 'pct', value: 0 },
    template:       document.getElementById('invoice-template').value,
    language:       document.getElementById('doc-lang').value,
    seller: {
      name:    document.getElementById('s-name').value.trim(),
      address: document.getElementById('s-addr').value.trim(),
      phone:   document.getElementById('s-phone').value.trim(),
      email:   document.getElementById('s-email').value.trim(),
    },
    buyer: {
      name:    document.getElementById('b-name').value.trim(),
      address: document.getElementById('b-addr').value.trim(),
      phone:   document.getElementById('b-phone').value.trim(),
      email:   document.getElementById('b-email').value.trim(),
      net_terms_days: Math.max(0, parseInt(document.getElementById('b-net-terms')?.value, 10) || 30),
    },
    items,
    notes: document.getElementById('notes').value.trim(),
    individual_disclaimer: document.getElementById('chk-individual-disclaimer').checked,
    status: currentInvoiceStatus,
    paid_date: currentInvoicePaidDate,
  };
}

// ── Drafts v2 storage ──────────────────────────────────────────────────────
// New per-draft storage keyed by a client-side UUID (see
// .planning/INVOICE_REDRAFT.md). Multiple drafts can coexist; each lives
// in its own slot. Drafts have NO invoice number — the number is assigned
// at issuance.
//
// The legacy `inv_draft_v1` slot (single-overloaded) is kept readable
// for one boot via migrateLegacyDraftIfNeeded() — that one-shot promotes
// it into v2 and removes the old key. After that, only v2 is touched.
const DRAFTS_V2_KEY = 'inv_drafts_v2';
let drafts = {};                  // { [local_id]: DraftRecord }
let _draftsPersistTimer = null;

function _readDraftsLS() {
  try {
    const raw = localStorage.getItem(DRAFTS_V2_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function _writeDraftsLS(map) {
  try { localStorage.setItem(DRAFTS_V2_KEY, JSON.stringify(map || {})); }
  catch (e) { /* quota — silent */ }
}

function loadDrafts() {
  drafts = _readDraftsLS();
  return drafts;
}

// Debounced 350ms — same cadence as the legacy autosave.
function persistDrafts() {
  if (_draftsPersistTimer) clearTimeout(_draftsPersistTimer);
  _draftsPersistTimer = setTimeout(() => _writeDraftsLS(drafts), 350);
}
// Immediate variant for destructive operations (delete, issue) where
// we must not race with a pending debounce.
function persistDraftsNow() {
  if (_draftsPersistTimer) { clearTimeout(_draftsPersistTimer); _draftsPersistTimer = null; }
  _writeDraftsLS(drafts);
}

// Generate a stable, opaque local id. Crypto.randomUUID where available,
// otherwise a time+random fallback. The 'd_' prefix makes draft ids easy
// to spot in logs and is a hint to debuggers that this is NOT a Supabase
// uuid.
function newDraftLocalId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return 'd_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    }
  } catch {}
  return 'd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Create a new draft from an optional seed payload (e.g. when
// duplicating an invoice or seeding a buyer block from the customer
// detail page). Inserts into the `drafts` map and persists.
function newDraft(seed = {}) {
  const nowIso = new Date().toISOString();
  const record = {
    local_id: newDraftLocalId(),
    created_at: nowIso,
    updated_at: nowIso,
    // The seed is a collectData()-shaped blob. It may contain
    // invoice_number from legacy code paths; drop it — drafts are
    // numberless until issuance.
    ...seed,
  };
  delete record.invoice_number;
  drafts[record.local_id] = record;
  persistDraftsNow();
  return record;
}

// Upsert a draft. `data` is the full collectData()-shaped payload.
// `updated_at` is refreshed; `local_id` and `created_at` are preserved
// from the existing record (or seeded if missing).
function saveDraftV2(local_id, data) {
  if (!local_id) return;
  const existing = drafts[local_id] || {};
  const nowIso = new Date().toISOString();
  drafts[local_id] = {
    ...existing,
    ...data,
    local_id,
    created_at: existing.created_at || nowIso,
    updated_at: nowIso,
  };
  // Drafts must never carry an invoice number.
  delete drafts[local_id].invoice_number;
  persistDrafts();
}

function deleteDraftV2(local_id) {
  if (!local_id || !drafts[local_id]) return;
  delete drafts[local_id];
  persistDraftsNow();
}

function getDraft(local_id) {
  return drafts[local_id] || null;
}
function listDrafts() {
  // Most recently edited first.
  return Object.values(drafts).sort((a, b) =>
    String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

// One-shot migration from the legacy single-slot draft. Runs at boot
// before any draft reads. Idempotent via a marker flag, so subsequent
// boots are no-ops.
//
// Promotes the legacy v1 payload into v2, then removes the v1 slot
// entirely. The legacy editor code path is no longer reachable in the
// redrafted system (see currentRouteName / routeView).
const DRAFTS_V2_MIGRATED_KEY = 'inv_drafts_v2_migrated';
function migrateLegacyDraftIfNeeded() {
  let alreadyDone;
  try { alreadyDone = localStorage.getItem(DRAFTS_V2_MIGRATED_KEY) === '1'; } catch { alreadyDone = false; }
  if (alreadyDone) {
    // Even on subsequent boots, ensure the legacy slot stays gone — a
    // crash or downgrade-then-upgrade could otherwise leave a stale v1
    // payload lying around.
    try { localStorage.removeItem(DRAFT_KEY); } catch {}
    return;
  }
  let raw;
  try { raw = localStorage.getItem(DRAFT_KEY); } catch { raw = null; }
  if (raw) {
    let entry; try { entry = JSON.parse(raw); } catch { entry = null; }
    const d = entry?.data;
    // The legacy slot was reused as a "load saved invoice into the form"
    // channel by older code. If we see a non-draft status, it's a stale
    // record-payload leftover; skip the promotion.
    if (d && (!d.status || d.status === 'draft')) {
      newDraft(d);
    }
  }
  // Always clear v1 and the stale next-number cache (computed from the
  // invoices list now, not a counter).
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
  try { localStorage.removeItem('inv_next_number'); } catch {}
  try { localStorage.setItem(DRAFTS_V2_MIGRATED_KEY, '1'); } catch {}
}

// Bind the editor form to a v2 draft. Hydrates the form from the
// draft's stored payload, sets editingDraftId so autosave routes back
// to v2, and flips the inv-num field to read-only with the live
// next-number hint. Called from routeView when entering #/drafts/<id>.
//
// If the draft doesn't exist (stale URL, manual hash edit), create a
// fresh one and redirect — never leave the user on a broken page.
function bindEditorToDraft(local_id) {
  let d = getDraft(local_id);
  if (!d) {
    // Stale URL or freshly-typed hash — mint a new draft and rewrite
    // the URL in place. `history.replaceState` avoids a queued
    // hashchange that would race the rest of this function; we
    // proceed to bind synchronously so the form is rendered in one
    // tick, no blank flash.
    d = newDraft({});
    try {
      history.replaceState(null, '', '#/drafts/' + encodeURIComponent(d.local_id));
    } catch {
      // Older browsers without replaceState fall back to a hash assign.
      location.hash = '#/drafts/' + encodeURIComponent(d.local_id);
    }
  }
  editingDraftId = d.local_id;
  currentInvoiceStatus = 'draft';
  currentInvoicePaidDate = null;
  // Reset the form to defaults first so any leftover state from a
  // previous draft / legacy session is cleared. applyPayloadToForm
  // then overlays whatever the draft has saved. _draftRestoring is
  // set inside applyPayloadToForm to suppress autosave during hydration.
  _draftRestoring = true;
  try {
    if (typeof resetEditorForm === 'function') resetEditorForm();
  } finally {
    _draftRestoring = false;
  }
  applyPayloadToForm(d);
  // Rehydrate the selected-customer / selected-company globals from the
  // draft's stashed links (resetEditorForm nulled them). Keeps the
  // autocomplete UI in sync and ensures the issued invoice keeps the
  // link even if the user never re-touches the combo (H4 in the audit).
  selCustId = d.customer_id || null;
  selCompId = d.company_id || null;
  refreshDraftEditorChrome();
}

// Make the inv-num field read-only + populate it with the live next
// number, and show the Issue card. Called on bind and on every
// recalc-triggering input so the hint stays fresh as other devices issue.
function refreshDraftEditorChrome() {
  if (!editingDraftId) return;
  const next = (typeof computeNextInvoiceNumber === 'function')
    ? computeNextInvoiceNumber()
    : 'INV-001';
  const numEl = document.getElementById('inv-num');
  if (numEl) {
    numEl.readOnly = true;
    numEl.classList.add('draft-num-readonly');
    numEl.value = next;
    numEl.title = 'Assigned at issuance — this is a preview of the next number';
  }
  // Hide the legacy "Editing INV-X" banner + status workflow UI in
  // draft-edit mode (drafts are always draft status; no manual flip).
  const banner = document.getElementById('editing-banner');
  if (banner) banner.hidden = true;
  const statusSection = document.getElementById('invoice-status-section');
  if (statusSection) statusSection.dataset.draftMode = '1';
  // Show the Issue card, hide the legacy Generate button. The Print PDF
  // preview button stays — it's a read-only render and is useful for
  // proofing a draft before issuing.
  const issueCard = document.getElementById('issue-card');
  if (issueCard) issueCard.hidden = false;
  const issueNum = document.getElementById('issue-card-number');
  if (issueNum) issueNum.textContent = next;
  const genBtn = document.getElementById('gen-btn');
  if (genBtn) genBtn.hidden = true;
  renderIssueCompanyOptions();
}

// Populate the "Issuing from" company <select> with the saved companies
// and reflect the current draft's company_id. The empty option is
// "Individual / no company".
function renderIssueCompanyOptions() {
  const sel = document.getElementById('issue-company');
  if (!sel) return;
  const current = selCompId || '';
  const opts = ['<option value="">Individual / no company</option>'];
  (companies || []).forEach(c => {
    opts.push(`<option value="${escapeHtml(c.id)}">${escapeHtml(c.name || '(unnamed company)')}</option>`);
  });
  sel.innerHTML = opts.join('');
  // If the draft's company no longer exists, fall back to Individual.
  sel.value = (companies || []).some(c => c.id === current) ? current : '';
}

// User picked a company (or Individual) from the issue-card selector.
// Applies it to the current draft's seller + company_id, remembers it
// as the default for future new invoices, and re-renders.
function onIssueCompanyChange() {
  const sel = document.getElementById('issue-company');
  if (!sel || !editingDraftId) return;
  const id = sel.value || '';
  const company = id ? (companies || []).find(c => c.id === id) : null;
  const set = (elId, v) => { const el = document.getElementById(elId); if (el) el.value = v ?? ''; };
  if (company) {
    set('s-name', company.name); set('s-addr', company.address);
    set('s-phone', company.phone); set('s-email', company.email);
    const chkInd = document.getElementById('chk-individual-disclaimer');
    if (chkInd) chkInd.checked = !!company.individual_disclaimer;
    selCompId = company.id;
  } else {
    // Individual: clear the seller block entirely.
    set('s-name', ''); set('s-addr', ''); set('s-phone', ''); set('s-email', '');
    const chkInd = document.getElementById('chk-individual-disclaimer');
    if (chkInd) chkInd.checked = false;
    selCompId = null;
  }
  rememberLastCompany(selCompId);
  // Persist company_id on the draft record (collectData omits it, so set
  // it directly), then write the updated seller fields via autosave.
  if (drafts[editingDraftId]) {
    drafts[editingDraftId].company_id = selCompId;
  }
  writeEditingDraft();
  recalc();
}

// Step 10 will remove the legacy chrome entirely. For now, when the
// editor view is shown WITHOUT editingDraftId set (legacy code paths,
// e.g. the deprecated openInvoiceFromList), restore the inv-num
// field's editability so the legacy editor still functions.
function clearDraftEditorChrome() {
  const numEl = document.getElementById('inv-num');
  if (numEl) {
    numEl.readOnly = false;
    numEl.classList.remove('draft-num-readonly');
    numEl.title = '';
  }
  const statusSection = document.getElementById('invoice-status-section');
  if (statusSection) delete statusSection.dataset.draftMode;
  const issueCard = document.getElementById('issue-card');
  if (issueCard) issueCard.hidden = true;
  const genBtn = document.getElementById('gen-btn');
  if (genBtn) genBtn.hidden = false;
}

// ── Draft autosave (legacy v1 — kept until step 10 cleanup pass) ─────────
// The full invoice form is persisted to localStorage so a tab swipe / page
// reload / crashed browser doesn't wipe in-progress work. Restore runs once
// at boot; saveDraft is debounced through recalc().
//
// When editingDraftId is set (#/drafts/<id> route), autosave is
// REDIRECTED to v2 storage via writeEditingDraft(). The legacy v1 path
// is kept for any remaining call sites that haven't migrated; step 10
// removes them.
const DRAFT_KEY = 'inv_draft_v1';
let _draftSaveTimer = null;
let _draftRestoring = false;

// Persist the current form state into the v2 draft the editor is bound
// to. Strips invoice_number (drafts are numberless). Called from
// onEditorInput when editingDraftId is set.
function writeEditingDraft() {
  if (!editingDraftId) return;
  const data = collectData();
  // Drafts never carry a number; the field shows the live next-number
  // hint, not a user-set value.
  delete data.invoice_number;
  saveDraftV2(editingDraftId, data);
}

// ─────────────────────────────────────────────────────────────────────
// ISSUE — commit a v2 draft to public.invoices and tear it down.
// ─────────────────────────────────────────────────────────────────────
// The DB is the authority on number uniqueness via the
// (user_id, number) unique index added in 2026-05-30-invoice-supersede.sql.
// On 23505 unique_violation the client retries with `next + 1`, up to
// ISSUE_MAX_RETRIES. Every other error surfaces to the user.
const ISSUE_MAX_RETRIES = 5;

async function issueDraft() {
  if (_issueBusy) return;   // re-entry guard (mobile double-tap, slow render)
  if (!editingDraftId) return;
  const draft = getDraft(editingDraftId);
  if (!draft) { toast('No draft to issue', 'error'); return; }
  if (!draft.buyer?.name) { toast('Please enter a client name first', 'error'); return; }
  const items = Array.isArray(draft.items) ? draft.items : [];
  if (items.length === 0 || !items.some(it => Number(it.qty) > 0 || Number(it.unit_price) > 0)) {
    toast('Add at least one line item', 'error');
    return;
  }

  const previewNumber = computeNextInvoiceNumber();
  const buyerLabel = draft.buyer?.name || '(no buyer)';
  if (!confirm(`Save ${previewNumber} to ${buyerLabel} and open for printing?`)) {
    return;
  }

  setIssueBusy(true);

  const _diagT0 = performance.now();
  const _diag = (m) => console.log(`[SAVE-DIAG +${Math.round(performance.now() - _diagT0)}ms] ${m}`);
  try {
    // Build the payload the renderer expects. The draft is numberless;
    // we inject the just-computed number into the snapshot so the PDF
    // header is correct.
    const data = { ...draft, invoice_number: previewNumber };
    _diag(`start. supabaseActive=${supabaseActive()} company_id=${draft.company_id || selCompId || null} seller=${JSON.stringify(draft.seller || {})}`);
    // Render the PDF first. If this fails, the draft is untouched.
    _diag('calling renderPdfForData…');
    const pdfInfo = await renderPdfForData(data);
    _diag(`renderPdfForData returned: ${pdfInfo ? 'ok (' + pdfInfo.filename + ')' : 'null'}`);
    if (!pdfInfo) {
      throw new Error('PDF generation failed');
    }
    // Insert with retry on number collision. Each retry recomputes the
    // next number against the latest invoices list — another tab issuing
    // simultaneously will have populated `invoices` already if we
    // refreshed, but the unique constraint is the authority either way.
    let saved = null;
    let attemptNumber = previewNumber;
    let lastErr = null;
    for (let i = 0; i < ISSUE_MAX_RETRIES; i++) {
      const record = buildIssueRecord(draft, attemptNumber, pdfInfo);
      try {
        _diag(`insertInvoiceRow attempt ${i + 1} (number=${attemptNumber})…`);
        saved = await insertInvoiceRow(record);
        _diag(`insertInvoiceRow OK id=${saved && saved.id}`);
        break;
      } catch (err) {
        lastErr = err;
        _diag(`insertInvoiceRow threw: code=${err && err.code} msg=${err && err.message}`);
        if (!isUniqueViolation(err)) throw err;
        // Re-read latest invoices and pick a new candidate number.
        await loadInvoices().catch(() => {});
        attemptNumber = computeNextInvoiceNumber();
      }
    }
    if (!saved) {
      throw lastErr || new Error('Could not assign a unique invoice number');
    }

    // If this draft was a supersede edit, void the original and link
    // it to the replacement via superseded_by. Best-effort: the new
    // invoice is already saved either way; a failure here surfaces as
    // a toast but doesn't roll back the issuance.
    const supersedesId = drafts[editingDraftId]?.supersedes;
    if (supersedesId) {
      try {
        await patchInvoice(supersedesId, { status: 'void', superseded_by: saved.id });
      } catch (err) {
        toast(`Issued ${saved.number}, but couldn't void the original — please void it manually`, 'error');
      }
    }
    // Draft is now superseded by the saved record; remove it.
    deleteDraftV2(editingDraftId);
    editingDraftId = null;
    setLastGeneratedPdf({
      filename: pdfInfo.filename,
      url: pdfInfo.url,
      blob: pdfInfo.blob,
      invoiceNumber: saved.number,
      isObjectUrl: !!pdfInfo.isObjectUrl,
    });
    // Save + print in one step: open the PDF in a new tab so the user
    // can hit Ctrl+P. Saved invoice detail opens in the current tab.
    try { window.open(pdfInfo.url, '_blank'); } catch {}
    toast(supersedesId
      ? `${saved.number} saved — replaces voided original. PDF opened for printing.`
      : `${saved.number} saved. PDF opened for printing.`, 'success');
    openInvoiceDetail(saved.id);
  } catch (err) {
    toast(err && err.message ? `Save failed: ${err.message}` : 'Save failed', 'error');
  } finally {
    setIssueBusy(false);
  }
}

// Toggle BOTH issue buttons (desktop #issue-btn + mobile #mobile-issue-btn)
// together. This is also the single re-entry guard: while busy, both are
// disabled so a frozen-looking mobile tap can't double-fire. Fixes the
// "mobile button does nothing / freezes" symptom (H1 in the flow audit).
let _issueBusy = false;
function setIssueBusy(busy) {
  _issueBusy = !!busy;
  [['issue-btn', 'Save & Print / حفظ وطباعة'], ['mobile-issue-btn', 'Save & Print']].forEach(([id, label]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = busy;
    el.textContent = busy ? 'Saving…' : label;
  });
}

function isUniqueViolation(err) {
  // Supabase / postgrest surfaces 23505 via .code on the returned error,
  // and the message contains "duplicate key value violates unique constraint".
  if (!err) return false;
  if (err.code === '23505') return true;
  const msg = String(err.message || '');
  return /duplicate key|unique constraint|23505/i.test(msg);
}

// Build a record ready for `saveInvoice`. The number comes from the
// caller (so retry can vary it without recomputing the whole record).
function buildIssueRecord(draft, number, pdfInfo) {
  const payload = { ...draft, invoice_number: number };
  // The grand total: trust the form's live recalc — collectData()
  // doesn't include the total, so we mirror buildInvoiceRecordFromForm.
  const totalText = (document.getElementById('t-grand')?.textContent || '').replace(/[^0-9.\-]/g, '');
  const total = parseFloat(totalText) || 0;
  return {
    number,
    status:      'issued',
    date:        payload.date,
    due_date:    payload.due_date,
    // Prefer the link stashed on the draft (set when seeding "for
    // customer/company X") over the transient globals, which
    // resetEditorForm nulls when the draft is opened (H4 in the audit).
    customer_id: draft.customer_id || selCustId || null,
    company_id:  draft.company_id  || selCompId || null,
    buyer:       payload.buyer,
    seller:      payload.seller,
    total,
    currency:    payload.currency,
    payload,
    history:     [{ at: new Date().toISOString(), from: 'draft', to: 'issued' }],
  };
}

// Insert one invoice row. Wraps the existing saveInvoice() helper so
// the issuance path stays decoupled from any legacy persistence quirks
// — and also rethrows on a unique violation so issueDraft() can retry.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`${label || 'Operation'} timed out after ${ms / 1000}s`)), ms)),
  ]);
}

async function insertInvoiceRow(record) {
  if (!supabaseActive()) {
    // Local / offline mode: saveInvoice succeeds with a fallback id.
    // No DB-side uniqueness to enforce; rely on the client compute.
    return await saveInvoice(record);
  }
  const nowIso = new Date().toISOString();
  // Optional columns added by later migrations. We start by sending
  // them all; if Supabase says a column doesn't exist in its schema
  // cache (typical when a migration hasn't been applied yet OR the
  // PostgREST cache hasn't refreshed), we drop just that column and
  // retry. The user can apply the relevant migration later without
  // blocking issuance.
  const OPTIONAL_COLUMNS = ['company_id', 'superseded_by', 'sent_at'];
  const fullBase = {
    number:   record.number,
    status:   record.status || 'issued',
    date:     record.date,
    due_date: record.due_date || null,
    customer_id: record.customer_id || null,
    company_id:  record.company_id  || null,
    buyer:    record.buyer || {},
    seller:   record.seller || {},
    total:    Number(record.total) || 0,
    currency: record.currency || 'USD',
    payload:  record.payload || {},
    history:  record.history || [],
    sent_at:  nowIso,
  };
  let base = { ...fullBase };
  const dropped = [];
  // Retry up to OPTIONAL_COLUMNS.length+1 times, each iteration drops
  // one column the schema cache complained about and tries again.
  // Columns that may carry a stale/invalid reference. If the DB rejects
  // the link (FK violation 23503, invalid uuid 22P02) we drop it and
  // still save the invoice — the link is a nicety, not a blocker.
  const DROPPABLE_LINKS = ['company_id', 'customer_id'];
  for (let attempt = 0; attempt < OPTIONAL_COLUMNS.length + DROPPABLE_LINKS.length + 1; attempt++) {
    // Bound each attempt so a stalled Supabase call (VPN/network) can't
    // hang the Save button forever — the true cause of the "freeze on
    // saving" when a company is selected.
    let data, error;
    const _it0 = performance.now();
    console.log(`[SAVE-DIAG] insert attempt ${attempt + 1}, columns: ${Object.keys(base).join(',')}`);
    try {
      ({ data, error } = await withTimeout(
        supabaseClient.from('invoices').insert({ ...base, user_id: supabaseUser.id }).select('*').single(),
        15000, 'Saving the invoice'));
    } catch (timeoutErr) {
      console.log(`[SAVE-DIAG] insert attempt ${attempt + 1} TIMED OUT/THREW after ${Math.round(performance.now() - _it0)}ms:`, timeoutErr && timeoutErr.message);
      throw timeoutErr;   // surfaces to issueDraft → toast + button reset
    }
    console.log(`[SAVE-DIAG] insert attempt ${attempt + 1} responded in ${Math.round(performance.now() - _it0)}ms. error=`, error ? `${error.code}: ${error.message}` : 'none');
    if (!error) {
      if (dropped.length) {
        console.warn('Invoice insert succeeded after dropping columns:', dropped.join(', '),
          '- apply the missing migrations in supabase/migrations/ or fix the link.');
      }
      invoices.unshift(data);
      return data;
    }
    // 23505 unique violation: rethrow for issueDraft's retry-with-next-number.
    if (error.code === '23505') {
      const e = new Error(error.message); e.code = error.code; throw e;
    }
    // Unknown/missing column. Two shapes depending on whether the answer
    // comes from PostgREST's schema cache or straight from Postgres:
    //   • PGRST204 — "Could not find the 'company_id' column of 'invoices'
    //     in the schema cache"
    //   • 42703 (undefined_column) — "column invoices.company_id does not
    //     exist"  ← what this project's Supabase returns when a migration
    //     (e.g. 2026-05-29-invoice-company-link.sql) hasn't been applied.
    // The old regex only matched the PGRST204 phrasing, so a 42703 fell
    // through to the throw below and broke issuance whenever company_id was
    // sent (i.e. a company was selected) — the "freeze/Save failed on
    // selecting my company" report. Detect both, then drop whichever
    // optional column the message names and retry.
    const msg = String(error.message || '');
    const missingColumn =
      error.code === 'PGRST204' ||
      error.code === '42703' ||
      /could not find the .*? column|column .*? does not exist|schema cache/i.test(msg);
    if (missingColumn) {
      const offending = OPTIONAL_COLUMNS.find(c => c in base && msg.includes(c));
      if (offending) {
        delete base[offending];
        dropped.push(offending);
        continue;
      }
    }
    // Bad reference (FK violation / invalid uuid) on a link column: drop
    // the link and retry so the invoice still saves.
    if ((error.code === '23503' || error.code === '22P02')) {
      const linkMsg = String(error.message || '');
      const link = DROPPABLE_LINKS.find(c => c in base && (linkMsg.includes(c) || true));
      if (link) {
        delete base[link];
        dropped.push(link + ' (bad reference)');
        continue;
      }
    }
    // Different error or non-optional column — surface to caller.
    const e = new Error(error.message || 'Insert failed');
    e.code = error.code;
    throw e;
  }
  throw new Error('Invoice insert exhausted retry budget');
}

// Render PDF from a payload (used by Issue). Reuses the existing
// requestPdfGeneration helper so the renderer code path is unchanged.
async function renderPdfForData(data) {
  const response = await requestPdfGeneration(data);
  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('application/pdf')) {
    const blob = await response.blob();
    const filename = filenameFromResponse(response, data.invoice_number);
    const url = URL.createObjectURL(blob);
    return { filename, url, blob, isObjectUrl: true };
  }
  const r = await response.json();
  if (!r.ok) return null;
  return { filename: r.filename, url: pdfDownloadUrl(r.filename), isObjectUrl: false };
}

async function discardCurrentDraft() {
  if (!editingDraftId) return;
  const d = getDraft(editingDraftId);
  const label = d?.buyer?.name ? `the draft for "${d.buyer.name}"` : 'this draft';
  if (!confirm(`Discard ${label}? It can't be recovered.`)) return;
  const id = editingDraftId;
  editingDraftId = null;
  clearDraftEditorChrome();
  deleteDraftV2(id);
  toast('Draft discarded', 'success');
  openDrafts();
}

// ─────────────────────────────────────────────────────────────────────
// INVOICE DETAIL (read-only) — #/invoices/<id>
// ─────────────────────────────────────────────────────────────────────
// Reuses the editor's DOM but disables all inputs and shows a
// dedicated action header (status, Mark paid / Void / Edit / Open PDF).
let viewingInvoiceId = null;

function renderInvoiceDetail(invoice_id) {
  if (!invoice_id) return;
  viewingInvoiceId = invoice_id;
  const inv = (invoices || []).find(r => r.id === invoice_id);
  if (!inv) {
    // List may not be loaded yet — render a placeholder; routeView
    // will re-call this after loadInvoices resolves.
    showInvoiceViewerPlaceholder();
    return;
  }
  // Hydrate the form from the invoice's payload (immutable snapshot).
  _draftRestoring = true;
  try {
    if (typeof resetEditorForm === 'function') resetEditorForm();
  } finally { _draftRestoring = false; }
  applyPayloadToForm(inv.payload || {});
  // Force the inv-num field to the saved number — applyPayloadToForm
  // already does this from payload.invoice_number but be explicit.
  const numEl = document.getElementById('inv-num');
  if (numEl) numEl.value = inv.number || numEl.value;
  // Toggle chrome.
  setInvoiceViewerChrome(inv);
}

function showInvoiceViewerPlaceholder() {
  setInvoiceViewerChrome(null);
}

// Configure view-invoice's chrome for read-only invoice display.
function setInvoiceViewerChrome(inv) {
  // Mark body so the all-disabled CSS rule kicks in.
  document.body.classList.add('viewing-invoice');
  // Hide draft chrome.
  if (typeof clearDraftEditorChrome === 'function') clearDraftEditorChrome();
  // Hide the legacy gen / print / status-section / banner.
  const genBtn   = document.getElementById('gen-btn');
  const issueCard= document.getElementById('issue-card');
  if (genBtn)    genBtn.hidden    = true;
  if (issueCard) issueCard.hidden = true;
  const banner   = document.getElementById('editing-banner');
  if (banner)    banner.hidden    = true;
  // Set the read-only inv-num style on the number field (same look as
  // draft-mode preview but for the assigned number).
  const numEl = document.getElementById('inv-num');
  if (numEl) {
    numEl.readOnly = true;
    numEl.classList.add('draft-num-readonly');
    numEl.title = 'Invoice number is fixed after issuance';
  }
  // Replace the side status-section's content with the detail action bar.
  const statusSection = document.getElementById('invoice-status-section');
  if (!statusSection) return;
  statusSection.dataset.detailMode = '1';
  if (!inv) {
    statusSection.innerHTML = `<div class="side-title">Invoice</div><p class="side-note">Loading…</p>`;
    return;
  }
  const eff = effectiveInvoiceStatus(inv);
  const isPaid  = inv.status === 'paid';
  const isVoid  = inv.status === 'void';
  const isDraft = inv.status === 'draft';
  const payAction = isPaid
    ? `<button class="ghost-btn" type="button" onclick="markUnpaid('${escapeHtml(inv.id)}')">Unpay</button>`
    : `<button class="ghost-btn" type="button" onclick="markInvoicePaid('${escapeHtml(inv.id)}')">Mark paid</button>`;
  const voidAction = (isVoid || isDraft) ? '' :
    `<button class="ghost-btn danger" type="button" onclick="voidInvoiceFromDetail('${escapeHtml(inv.id)}')">Void</button>`;
  const editAction = isVoid ? '' :
    `<button class="ghost-btn" type="button" onclick="startSupersedeFlow('${escapeHtml(inv.id)}')">Edit (supersede)</button>`;

  // Supersede relationships: this invoice may have replaced an older
  // one, or may itself have been replaced by a newer one.
  const replacedById = inv.superseded_by;
  const replacedBy = replacedById ? (invoices || []).find(r => r.id === replacedById) : null;
  const replaces = (invoices || []).find(r => r.superseded_by === inv.id);
  let supersedeBanner = '';
  if (replacedBy) {
    supersedeBanner = `
      <div class="status-row" style="background: color-mix(in srgb, #dc2626 12%, var(--surface)); border-radius: 8px; padding: 10px 12px; margin-top: 10px; flex-direction: column; align-items: flex-start; gap: 4px;">
        <strong style="font-size: 12px; color: #dc2626;">Voided — replaced by ${escapeHtml(replacedBy.number)}</strong>
        <button class="ghost-btn" type="button" onclick="openInvoiceDetail('${escapeHtml(replacedBy.id)}')" style="padding: 4px 8px; font-size: 11px;">Open ${escapeHtml(replacedBy.number)}</button>
      </div>`;
  } else if (replaces) {
    supersedeBanner = `
      <div class="status-row" style="background: color-mix(in srgb, var(--accent) 12%, var(--surface)); border-radius: 8px; padding: 10px 12px; margin-top: 10px; flex-direction: column; align-items: flex-start; gap: 4px;">
        <strong style="font-size: 12px; color: var(--accent2);">Replaces ${escapeHtml(replaces.number)}</strong>
        <button class="ghost-btn" type="button" onclick="openInvoiceDetail('${escapeHtml(replaces.id)}')" style="padding: 4px 8px; font-size: 11px;">View original</button>
      </div>`;
  }

  statusSection.innerHTML = `
    <div class="side-title">Invoice ${escapeHtml(inv.number || '')}</div>
    <div class="status-row">
      <span class="status-badge" data-status="${eff}">${eff.charAt(0).toUpperCase() + eff.slice(1)}</span>
      <span class="status-meta">${escapeHtml(inv.date || '')}</span>
    </div>
    ${supersedeBanner}
    <div class="status-side-actions invoice-detail-actions">
      ${payAction}
      <button class="ghost-btn" type="button" onclick="duplicateInvoiceToDraft('${escapeHtml(inv.id)}')">Duplicate</button>
      ${editAction}
      ${voidAction}
      <button class="ghost-btn" type="button" onclick="openInvoicePdf('${escapeHtml(inv.id)}')">Open PDF</button>
    </div>
    <p class="side-note" style="margin-top:10px">This is a read-only view of an issued invoice. To change it, use <strong>Edit</strong> — that creates a new draft and supersedes this one when issued.</p>`;
}

// Cleanup when leaving the invoice-detail route.
function clearInvoiceViewerChrome() {
  document.body.classList.remove('viewing-invoice');
  const numEl = document.getElementById('inv-num');
  if (numEl) {
    numEl.readOnly = false;
    numEl.classList.remove('draft-num-readonly');
    numEl.title = '';
  }
  const statusSection = document.getElementById('invoice-status-section');
  if (statusSection) delete statusSection.dataset.detailMode;
  const genBtn = document.getElementById('gen-btn');
  if (genBtn) genBtn.hidden = false;
}

// Void from the detail page action bar. Same effect as the list-row
// "delete on issued/paid" which patches to status='void'.
async function voidInvoiceFromDetail(id) {
  const inv = (invoices || []).find(r => r.id === id);
  if (!inv) return;
  if (!confirm(`Void ${inv.number}? It will stay in the list with a strikethrough.`)) return;
  await patchInvoice(id, { status: 'void' });
  toast(`${inv.number} voided`, 'success');
  renderInvoiceDetail(id);
}

// Duplicate an issued invoice into a new draft (no number).
function duplicateInvoiceToDraft(id) {
  const inv = (invoices || []).find(r => r.id === id);
  if (!inv) { toast('Invoice not found', 'error'); return; }
  const seed = { ...(inv.payload || {}) };
  delete seed.invoice_number;
  // Refresh the date — duplicates usually issue on today's date.
  seed.date = new Date().toISOString().slice(0, 10);
  delete seed.due_date;
  const d = newDraft(seed);
  openDraft(d.local_id);
  toast(`Duplicated ${inv.number} into a new draft`, 'success');
}

// Open the stored PDF, regenerating from the saved payload if the
// blob isn't in memory.
async function openInvoicePdf(id) {
  const inv = (invoices || []).find(r => r.id === id);
  if (!inv?.payload) { toast('No payload for this invoice', 'error'); return; }
  // We don't persist the blob — re-render from the snapshot.
  const data = { ...inv.payload, invoice_number: inv.number };
  try {
    const info = await renderPdfForData(data);
    if (!info) { toast('Could not render PDF', 'error'); return; }
    setLastGeneratedPdf({ ...info, invoiceNumber: inv.number });
    window.open(info.url, '_blank');
  } catch (err) {
    toast(`PDF render failed: ${err?.message || 'unknown'}`, 'error');
  }
}

// Begin the edit/supersede flow. Clone the issued invoice's payload
// into a new draft, mark the draft with `supersedes: <original_id>`,
// and navigate to the new draft. When issueDraft commits, it will
// also void the original with superseded_by pointing at the new id.
function startSupersedeFlow(id) {
  const inv = (invoices || []).find(r => r.id === id);
  if (!inv) { toast('Invoice not found', 'error'); return; }
  if (!confirm(
    `Editing ${inv.number} supersedes the original.\n\n` +
    `When you Issue the new version, ${inv.number} will be voided and ` +
    `linked to the replacement (preserved for audit). Continue?`
  )) return;
  const seed = { ...(inv.payload || {}) };
  delete seed.invoice_number;        // new number assigned at issuance
  seed.date = new Date().toISOString().slice(0, 10);
  delete seed.due_date;
  const draft = newDraft(seed);
  // Tag the supersede relationship inside the draft record itself so
  // issueDraft can read it. saveDraftV2 preserves arbitrary fields.
  drafts[draft.local_id].supersedes = inv.id;
  drafts[draft.local_id].supersedes_number = inv.number;
  persistDraftsNow();
  openDraft(draft.local_id);
  toast(`Replacing ${inv.number} — issue when ready`, 'success');
}

// Alias for any callers that imported the longer name.
function beginSupersede(id) { return startSupersedeFlow(id); }

function saveDraft() {
  if (_draftRestoring) return;
  // Never overwrite the draft slot while editing a saved record — those
  // edits must land on the server via "Save changes" or stay ephemeral.
  if (editor.mode === 'editing') return;
  if (_draftSaveTimer) clearTimeout(_draftSaveTimer);
  _draftSaveTimer = setTimeout(() => {
    try {
      const data = collectData();
      // Don't persist a completely empty form — nothing to restore.
      const hasContent = data.buyer.name || data.notes
        || (data.items && data.items.length > 0)
        || data.status !== 'draft' || data.paid_date;
      if (!hasContent) { localStorage.removeItem(DRAFT_KEY); return; }
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), data }));
    } catch (e) { /* quota / serialization — silent */ }
  }, 350);
}

function clearDraft() {
  if (_draftSaveTimer) clearTimeout(_draftSaveTimer);
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
}

// Pure DOM hydration. No localStorage side effects. Two callers:
//   - restoreDraft() — pulls payload from the inv_draft_v1 slot.
//   - loadInvoiceIntoEditor() — applies a saved invoice's payload.
function applyPayloadToForm(d) {
  if (!d) return;
  _draftRestoring = true;
  try {
    const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
    set('inv-num',   d.invoice_number);
    set('inv-date',  d.date);
    set('currency',  d.currency);
    set('vat-pct',   d.vat_pct);
    set('invoice-template', d.template);
    set('doc-lang',  d.language);
    set('notes',     d.notes);
    // Due date toggle
    const chkDue = document.getElementById('chk-due');
    if (chkDue) { chkDue.checked = !!d.due_date; if (typeof toggleDue === 'function') toggleDue(); }
    if (d.due_date) set('inv-due', d.due_date);
    // Buyer / seller fields
    if (d.buyer) {
      set('b-name', d.buyer.name); set('b-addr', d.buyer.address);
      set('b-phone', d.buyer.phone); set('b-email', d.buyer.email);
      set('b-net-terms', d.buyer.net_terms_days ?? 30);
    }
    if (d.seller) {
      set('s-name', d.seller.name); set('s-addr', d.seller.address);
      set('s-phone', d.seller.phone); set('s-email', d.seller.email);
    }
    // Line discount toggle
    const chkDisc = document.getElementById('chk-discount');
    if (chkDisc) { chkDisc.checked = !!d.include_discount; if (typeof toggleDiscount === 'function') toggleDiscount(); }
    // Invoice-wide discount
    const chkInvDisc = document.getElementById('chk-invoice-disc');
    if (chkInvDisc) {
      chkInvDisc.checked = !!d.invoice_discount?.enabled;
      if (typeof toggleInvoiceDiscount === 'function') toggleInvoiceDiscount();
    }
    if (d.invoice_discount?.enabled) {
      set('invoice-disc-type',  d.invoice_discount.type);
      set('invoice-disc-value', d.invoice_discount.value);
    }
    // Individual disclaimer toggle (lives on the company-side block but is
    // persisted with the invoice payload).
    const chkInd = document.getElementById('chk-individual-disclaimer');
    if (chkInd) chkInd.checked = !!d.individual_disclaimer;
    // Items — rebuild from scratch
    if (Array.isArray(d.items) && d.items.length > 0) {
      const body = document.getElementById('items-body');
      if (body) {
        body.innerHTML = '';
        rowCount = 0;
        d.items.forEach(it => {
          addRow();
          const id = rowCount;
          const dEl = document.getElementById('desc-'+id);  if (dEl) dEl.value = it.description || '';
          const qEl = document.getElementById('qty-'+id);   if (qEl) qEl.value = it.qty ?? '';
          const uEl = document.getElementById('up-'+id);    if (uEl) uEl.value = it.unit_price ?? '';
          const xEl = document.getElementById('disc-'+id);  if (xEl) xEl.value = it.discount_pct ?? 0;
        });
      }
    }
    // Status (consumed by renderInvoiceStatus)
    currentInvoiceStatus   = d.status || 'draft';
    currentInvoicePaidDate = d.paid_date || null;
    if (typeof renderInvoiceStatus === 'function') renderInvoiceStatus();
  } finally {
    _draftRestoring = false;
  }
  recalc();
}

function restoreDraft() {
  let raw; try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return false; }
  if (!raw) return false;
  let entry; try { entry = JSON.parse(raw); } catch (e) { return false; }
  const d = entry?.data; if (!d) return false;
  // Back-compat: the OLD loadInvoiceIntoEditor wrote saved-record payloads
  // into the draft slot. If we see one of those leftovers (a non-draft
  // status) discard it silently — never auto-rebind to a saved record on
  // reload.
  if (d.status && d.status !== 'draft') {
    try { localStorage.removeItem(DRAFT_KEY); } catch {}
    return false;
  }
  applyPayloadToForm(d);
  return true;
}

// ── Generate invoice ───────────────────────────────────────────────────────
function pdfDownloadUrl(filename) {
  return `/api/download/${encodeURIComponent(filename)}`;
}

function directPdfUrl(filename) {
  return filename ? pdfDownloadUrl(filename) : '';
}

function setLastGeneratedPdf(fileInfo) {
  if (lastGeneratedPdf?.isObjectUrl) URL.revokeObjectURL(lastGeneratedPdf.url);
  if (!fileInfo) {
    lastGeneratedPdf = null;
  } else if (typeof fileInfo === 'string') {
    lastGeneratedPdf = {
      filename: fileInfo,
      url: directPdfUrl(fileInfo),
      invoiceNumber: document.getElementById('inv-num').value.trim() || 'INV-001',
      isObjectUrl: false,
    };
  } else {
    lastGeneratedPdf = {
      filename: fileInfo.filename,
      url: fileInfo.url,
      blob: fileInfo.blob || null,
      invoiceNumber: fileInfo.invoiceNumber || document.getElementById('inv-num').value.trim() || 'INV-001',
      isObjectUrl: !!fileInfo.isObjectUrl,
    };
  }

  const status = document.getElementById('mobile-pdf-status');
  const shareBtn = document.getElementById('mobile-share-btn');
  const openBtn = document.getElementById('mobile-open-btn');
  const activeFilename = lastGeneratedPdf?.filename || '';
  if (status) status.textContent = activeFilename || 'No PDF generated yet';
  if (shareBtn) shareBtn.disabled = !activeFilename;
  if (openBtn) openBtn.disabled = !activeFilename;
}

function filenameFromResponse(response, invoiceNumber) {
  const explicit = response.headers.get('X-Invoice-Filename');
  if (explicit) return explicit;
  const disposition = response.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/i);
  return match ? match[1] : `${invoiceNumber || 'INV-001'}.pdf`;
}

function nextInvoiceNumber(value) {
  const current = String(value || 'INV-001');
  const match = current.match(/^(.*?)(\d+)$/);
  if (!match) return 'INV-001';
  const [, prefix, digits] = match;
  return prefix + String(Number(digits) + 1).padStart(digits.length, '0');
}

function validateInvoiceData(data) {
  if (!data.buyer.name) {
    toast('Please enter a client name', 'error');
    return false;
  }
  if (!data.items.length) {
    toast('Add at least one item', 'error');
    return false;
  }
  return true;
}

async function generatePdfFile(options = {}) {
  const data = collectData();
  if (!validateInvoiceData(data)) return null;

  const btn = options.button || null;
  const previousLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Generating...';
  }

  try {
    const response = await requestPdfGeneration(data);
    const contentType = response.headers.get('Content-Type') || '';

    if (contentType.includes('application/pdf')) {
      const blob = await response.blob();
      const filename = filenameFromResponse(response, data.invoice_number);
      const url = URL.createObjectURL(blob);
      setLastGeneratedPdf({
        filename,
        url,
        blob,
        invoiceNumber: data.invoice_number,
        isObjectUrl: true,
      });
      if (options.download) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
      }
      if (options.open) window.open(url, '_blank');
      const wasEditing = editor.mode === 'editing';
      const boundLabel = editor.boundNumber;
      await persistGeneratedInvoice(data.invoice_number);
      if (wasEditing) {
        // Patched in place — keep the form bound and the number unchanged.
        toast(`Saved changes to ${boundLabel || data.invoice_number}`, 'success');
      } else {
        setInvoiceNumber(computeNextInvoiceNumber());
        toast(`${filename} ready`, 'success');
      }
      rememberItems(data.items);
      return filename;
    }

    const r = await response.json();
    if (!r.ok) {
      toast('Error: ' + (r.error || 'PDF generation failed'), 'error');
      return null;
    }

    setLastGeneratedPdf(r.filename);
    if (options.download) {
      const a = document.createElement('a');
      a.href = pdfDownloadUrl(r.filename);
      a.download = r.filename;
      a.click();
    }
    if (options.open) {
      window.open(pdfDownloadUrl(r.filename), '_blank');
    }
    const wasEditing2 = editor.mode === 'editing';
    const boundLabel2 = editor.boundNumber;
    await persistGeneratedInvoice(data.invoice_number);
    if (wasEditing2) {
      toast(`Saved changes to ${boundLabel2 || data.invoice_number}`, 'success');
    } else {
      setInvoiceNumber(computeNextInvoiceNumber());
      toast(`${r.filename} ready`, 'success');
    }
    rememberItems(data.items);
    return r.filename;
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    toast(timedOut ? 'PDF generation timed out. Please try again.' : `PDF endpoint unavailable: ${err.message || 'check connection'}`, 'error');
    return null;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = previousLabel;
    }
  }
}

async function requestPdfGeneration(data) {
  const payload = JSON.stringify(data);
  const endpoints = ['/api/generate-pdf', '/api/generate'];
  let lastError = null;

  // Each endpoint gets a bounded wait via AbortController (mirrors the
  // API() helper). Without this a stalled render hangs the await forever
  // and the issue button looks frozen (H2 in the flow audit).
  const PDF_TIMEOUT_MS = 25000;
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PDF_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: controller.signal,
      });
      if (response.ok) return response;
      lastError = new Error(`${endpoint} returned ${response.status}`);
    } catch (err) {
      lastError = err && err.name === 'AbortError'
        ? new Error(`${endpoint} timed out after ${PDF_TIMEOUT_MS / 1000}s`)
        : new Error(`${endpoint} failed`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error('PDF generation failed');
}

async function generateMobilePdf() {
  const filename = await generatePdfFile({ button: document.getElementById('mobile-pdf-btn') });
  if (filename) openPdfPreview();
}

function openLastPdf() {
  if (!lastGeneratedPdf) {
    toast('Generate a PDF first', 'error');
    return;
  }
  window.open(lastGeneratedPdf.url, '_blank');
}

async function loadPdfRenderer() {
  if (pdfJsModule) return pdfJsModule;
  pdfJsModule = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs');
  pdfJsModule.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs';
  return pdfJsModule;
}

async function lastPdfBlob() {
  if (!lastGeneratedPdf) return null;
  if (lastGeneratedPdf.blob) return lastGeneratedPdf.blob;
  const response = await fetch(lastGeneratedPdf.url);
  const blob = await response.blob();
  lastGeneratedPdf.blob = blob;
  return blob;
}

async function renderPdfPreview() {
  const body = document.getElementById('pdf-preview-body');
  const canvas = document.getElementById('pdf-preview-canvas');
  const loading = document.getElementById('pdf-preview-loading');
  if (!body || !canvas || !loading) return;

  loading.style.display = 'block';
  loading.textContent = 'Rendering preview...';
  canvas.style.display = 'none';

  try {
    const pdfjs = await loadPdfRenderer();
    const blob = await lastPdfBlob();
    const buffer = await blob.arrayBuffer();
    const pdf = await pdfjs.getDocument({
      data: buffer,
      cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/standard_fonts/',
    }).promise;
    const page = await pdf.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const maxWidth = Math.max(260, body.clientWidth - 28);
    const scale = Math.min(1.7, maxWidth / baseViewport.width);
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    const context = canvas.getContext('2d');

    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: context, viewport }).promise;
    loading.style.display = 'none';
    canvas.style.display = 'block';
  } catch (err) {
    loading.innerHTML = 'Preview could not render here.<br><button class="secondary-btn" type="button" onclick="openLastPdf()">Open PDF</button>';
  }
}

function openPdfPreview() {
  if (!lastGeneratedPdf) {
    toast('Generate a PDF first', 'error');
    return;
  }
  const modal = document.getElementById('pdf-preview-modal');
  const filename = document.getElementById('pdf-preview-filename');
  if (filename) filename.textContent = lastGeneratedPdf.filename;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  renderPdfPreview();
}

function closePdfPreview() {
  const modal = document.getElementById('pdf-preview-modal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  const canvas = document.getElementById('pdf-preview-canvas');
  if (canvas) {
    const context = canvas.getContext('2d');
    context && context.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function closePdfPreviewOnBackdrop(event) {
  if (event.target.id === 'pdf-preview-modal') closePdfPreview();
}

function isMobileDevice() {
  return window.matchMedia('(max-width: 780px), (pointer: coarse)').matches;
}

async function shareGeneratedPdf() {
  if (!lastGeneratedPdf) return false;
  const absoluteUrl = new URL(lastGeneratedPdf.url, window.location.href).href;
  const title = `Invoice ${lastGeneratedPdf.invoiceNumber}`;
  const text = `${title} PDF`;

  try {
    if (navigator.share) {
      const blob = await lastPdfBlob();
      const file = new File([blob], lastGeneratedPdf.filename, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ title, text, files: [file] });
        return true;
      }
      await navigator.share({ title, text, url: absoluteUrl });
      return true;
    }
  } catch (err) {
    // Fall through to WhatsApp/text URL fallback.
  }

  const whatsappText = encodeURIComponent(`${text}: ${absoluteUrl}`);
  window.open(`https://wa.me/?text=${whatsappText}`, '_blank');
  return true;
}

async function shareMobilePdf() {
  if (!lastGeneratedPdf) {
    const made = await generatePdfFile({ button: document.getElementById('mobile-share-btn') });
    if (!made) return;
  }
  await shareGeneratedPdf();
}

async function generateInvoice() {
  const btn  = document.getElementById('gen-btn');
  await generatePdfFile({ button: btn, download: true });
  updateActionSummary();
}

// ── Toast ──────────────────────────────────────────────────────────────────
async function printPdfInvoice() {
  const data = collectData();

  if (!data.buyer.name) { toast('Please enter a client name', 'error'); return; }
  if (!data.items.length) { toast('Add at least one item', 'error'); return; }

  try {
    if (isMobileDevice()) {
      const filename = await generatePdfFile();
      if (filename) openPdfPreview();
      return;
    }
    await generatePdfFile({ open: true });
    return;
    const r = await API('POST', '/api/print-preview', data);
    if (r.ok && r.url) {
      window.open(r.url, '_blank');
      setInvoiceNumber(r.next_invoice_number || document.getElementById('inv-num').value);
    } else {
      toast('Error: ' + (r.error || 'Print preview failed'), 'error');
    }
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    toast(timedOut ? 'Print preview timed out. Please try again.' : `PDF endpoint unavailable: ${err.message || 'check connection'}`, 'error');
  }
}

function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ── Currency change ────────────────────────────────────────────────────────
document.getElementById('currency').addEventListener('change', recalc);
document.getElementById('vat-pct').addEventListener('input', recalc);

// Init recalc
recalc();

// ─────────────────────────────────────────────────────────────────────────
// INVOICES LIST PAGE — render, filters, search, sort, group, bulk actions
// ─────────────────────────────────────────────────────────────────────────

// UI state for the list page (not persisted; resets between sessions).
let invListFilter = 'all';
let invListSort   = 'date_desc';
let invListGroup  = false;
let invListSearch = '';
let invListShowVoid = false;
const invSelection = new Set();

function toggleShowVoid() {
  const chk = document.getElementById('invoices-show-void');
  invListShowVoid = !!(chk && chk.checked);
  renderInvoicesPage();
}

function setInvoiceFilter(status) {
  invListFilter = status;
  document.querySelectorAll('#invoices-chips .chip').forEach(c => {
    c.classList.toggle('active', c.dataset.status === status);
  });
  renderInvoicesPage();
}
function onInvoicesSearch() {
  invListSearch = (document.getElementById('invoices-search')?.value || '').trim().toLowerCase();
  renderInvoicesPage();
}
function onInvoicesSort() {
  invListSort = document.getElementById('invoices-sort').value;
  renderInvoicesPage();
}
function onInvoicesGroupToggle() {
  invListGroup = document.getElementById('invoices-group-by-customer').checked;
  renderInvoicesPage();
}
function clearBulkSelection() {
  invSelection.clear();
  renderInvoicesPage();
}

// "Overdue" is derived. status=='issued' AND today > (date + buyer.net_terms_days).
function invoiceIsOverdue(inv) {
  if (inv.status !== 'issued') return false;
  if (!inv.date) return false;
  const issued = new Date(inv.date + 'T00:00:00');
  if (isNaN(issued)) return false;
  const net = parseInt(inv.buyer?.net_terms_days ?? 30, 10);
  const due = new Date(issued.getTime() + net * 864e5);
  return new Date() > due;
}
function effectiveInvoiceStatus(inv) {
  if (inv.status === 'void') return 'void';
  if (inv.status === 'paid') return 'paid';
  if (invoiceIsOverdue(inv)) return 'overdue';
  return inv.status || 'draft';
}
function statusBadge(status) {
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return `<span class="status-badge" data-status="${status}">${label}</span>`;
}
function fmtMoney(amount, currency) {
  return (currency || 'USD') + ' ' + Number(amount || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Filter+search+sort pipeline. Returns rows ready for grouping/render.
function pipelineInvoices() {
  let rows = (invoices || []).slice();
  // Void records are hidden by default — opt in via the "Show voided"
  // toggle, or by explicitly selecting the 'void' filter chip.
  if (!invListShowVoid && invListFilter !== 'void') {
    rows = rows.filter(r => effectiveInvoiceStatus(r) !== 'void');
  }
  // Filter
  if (invListFilter !== 'all') {
    rows = rows.filter(r => effectiveInvoiceStatus(r) === invListFilter);
  }
  // Search
  if (invListSearch) {
    rows = rows.filter(r => {
      const buyer = (r.buyer?.name || '').toLowerCase();
      const num   = (r.number || '').toLowerCase();
      return buyer.includes(invListSearch) || num.includes(invListSearch);
    });
  }
  // Sort
  const dir = invListSort.endsWith('asc') ? 1 : -1;
  rows.sort((a, b) => {
    if (invListSort.startsWith('date'))  return dir * (String(a.date).localeCompare(String(b.date)));
    if (invListSort.startsWith('total')) return dir * (Number(a.total) - Number(b.total));
    if (invListSort === 'status')        return effectiveInvoiceStatus(a).localeCompare(effectiveInvoiceStatus(b));
    if (invListSort === 'buyer')         return (a.buyer?.name || '').localeCompare(b.buyer?.name || '');
    return 0;
  });
  return rows;
}

function renderChipCounts() {
  const visibleSource = invListShowVoid
    ? invoices
    : invoices.filter(r => effectiveInvoiceStatus(r) !== 'void');
  const counts = { all: visibleSource.length, draft: 0, issued: 0, overdue: 0, paid: 0, void: 0 };
  // Void count is always the total — that chip ignores the show-void toggle
  // so the user can click it to switch into "voided only" view.
  invoices.forEach(r => {
    const eff = effectiveInvoiceStatus(r);
    if (eff === 'void') counts.void += 1;
    else counts[eff] = (counts[eff] || 0) + 1;
  });
  document.querySelectorAll('#invoices-chips .chip').forEach(chip => {
    const key = chip.dataset.status;
    const existing = chip.querySelector('.chip-count');
    const html = ` <span class="chip-count">${counts[key] || 0}</span>`;
    if (existing) existing.remove();
    chip.insertAdjacentHTML('beforeend', html);
  });
}

function rowHtml(inv) {
  const eff = effectiveInvoiceStatus(inv);
  const isSelected = invSelection.has(inv.id);
  const buyerName = inv.buyer?.name || '(no buyer)';
  const buyerMeta = inv.buyer?.email || inv.buyer?.phone || '';
  const due = inv.due_date || '—';
  const isPaid = inv.status === 'paid';
  const payBtn = isPaid
    ? `<button class="row-action" type="button" onclick="event.stopPropagation(); markUnpaid('${inv.id}')">Unpay</button>`
    : `<button class="row-action pay" type="button" onclick="event.stopPropagation(); markInvoicePaid('${inv.id}')">Paid</button>`;
  const history = Array.isArray(inv.history) ? inv.history.slice().reverse() : [];
  const historyHtml = history.length
    ? `<div class="invoice-row-history" onclick="event.stopPropagation()">
         <strong>Status history</strong>
         <ol>${history.map(h => `<li>${escapeHtml(h.at?.slice(0, 10) || '')} · ${escapeHtml(h.from || '')} → ${escapeHtml(h.to || '')}</li>`).join('')}</ol>
       </div>`
    : '';
  return `
    <div class="invoice-row${isSelected ? ' selected' : ''}${eff === 'void' ? ' voided' : ''}" data-id="${inv.id}" onclick="openInvoiceFromList('${inv.id}')">
      <label class="row-check" onclick="event.stopPropagation()">
        <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleRowSelected('${inv.id}', this.checked)">
      </label>
      <div class="row-num">${escapeHtml(inv.number || '')}</div>
      <div class="row-buyer">
        ${escapeHtml(buyerName)}
        ${buyerMeta ? `<span class="row-buyer-meta">${escapeHtml(buyerMeta)}</span>` : ''}
      </div>
      <div class="row-date">${escapeHtml(inv.date || '')}</div>
      <div class="row-due">${escapeHtml(due)}</div>
      <div class="row-status">${statusBadge(eff)}</div>
      <div class="row-total">${fmtMoney(inv.total, inv.currency)}</div>
      <div class="row-actions" onclick="event.stopPropagation()">
        ${payBtn}
        <button class="row-action" type="button" onclick="duplicateInvoiceFromList('${inv.id}')">Copy</button>
        <button class="row-action" type="button" onclick="toggleHistoryRow(this)">⋯</button>
        <button class="row-action danger" type="button" onclick="deleteInvoiceFromList('${inv.id}')" aria-label="Delete">✕</button>
      </div>
      ${historyHtml}
    </div>`;
}

function toggleHistoryRow(btn) {
  btn.closest('.invoice-row').classList.toggle('expanded');
}

function renderInvoicesPage() {
  const list = document.getElementById('invoices-list');
  if (!list) return;
  renderChipCounts();
  const rows = pipelineInvoices();
  if (rows.length === 0) {
    list.innerHTML = `<div class="invoices-empty">
      <strong>No invoices yet.</strong><br>
      ${invoices.length === 0
        ? 'Generate one from the editor to populate this list.'
        : 'No matches for the current filter or search.'}
    </div>`;
    updateBulkBar();
    return;
  }
  if (invListGroup) {
    // Group by customer (or "(no buyer)") with outstanding total in header.
    const groups = new Map();
    rows.forEach(r => {
      const key = r.buyer?.name || '(no buyer)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });
    list.innerHTML = Array.from(groups.entries()).map(([name, rs]) => {
      const outstanding = rs
        .filter(r => effectiveInvoiceStatus(r) === 'issued' || effectiveInvoiceStatus(r) === 'overdue')
        .reduce((sum, r) => sum + Number(r.total || 0), 0);
      const cur = rs[0]?.currency || 'USD';
      const id = rs[0]?.customer_id || '';
      const headLink = id
        ? `onclick="goToCustomer('${id}')"`
        : '';
      return `
        <div class="invoice-group-head">
          <h3 ${headLink}>${escapeHtml(name)}</h3>
          <div class="outstanding">${rs.length} invoice${rs.length === 1 ? '' : 's'} · Outstanding <strong>${fmtMoney(outstanding, cur)}</strong></div>
        </div>
        ${rs.map(rowHtml).join('')}`;
    }).join('');
  } else {
    list.innerHTML = rows.map(rowHtml).join('');
  }
  updateBulkBar();
}

// ── Row actions ───────────────────────────────────────────────────────────
function openInvoiceFromList(id) {
  const inv = invoices.find(r => r.id === id);
  if (!inv) return;
  // Redraft: navigate to the read-only detail page instead of the
  // legacy "load saved invoice into editor" flow. Edits go through
  // the supersede action on the detail page.
  openInvoiceDetail(id);
}

function loadInvoiceIntoEditor(inv) {
  // Restore from inv.payload — same shape used by the draft restore path.
  if (!inv?.payload) return;
  currentInvoiceStatus = inv.status || 'draft';
  currentInvoicePaidDate = inv.paid_at ? (inv.paid_at.slice(0, 10)) : null;
  applyPayloadToForm(inv.payload);
  setEditorMode('editing', inv);
  if (typeof renderInvoiceStatus === 'function') renderInvoiceStatus();
}

// Re-render whichever invoice-bearing view is currently active. Used
// after status patches so the change is reflected wherever the user is
// — the list, a customer/company detail, or the invoice detail page.
function rerenderActiveInvoiceView() {
  const route = currentRouteName();
  if (route === 'invoices')        { renderInvoicesPage(); return; }
  if (route === 'invoice-detail')  { renderInvoiceDetail(viewingInvoiceId); return; }
  if (route === 'customer-detail') { renderCustomerDetail(_currentCustomerDetailId); return; }
  if (route === 'company-detail')  { renderCompanyDetail(_currentCompanyDetailId); return; }
  if (route === 'home')            { renderHomePage(); return; }
  if (route === 'financial')       { renderFinancialPage(); return; }
}

async function markInvoicePaid(id) {
  await patchInvoice(id, { status: 'paid' });
  rerenderActiveInvoiceView();
  toast('Marked paid', 'success');
}
async function markUnpaid(id) {
  await patchInvoice(id, { status: 'issued', paid_at: null });
  rerenderActiveInvoiceView();
  toast('Reverted to issued', 'success');
}
async function deleteInvoiceFromList(id) {
  const inv = invoices.find(r => r.id === id);
  if (!inv) return;
  const eff = effectiveInvoiceStatus(inv);
  if (eff !== 'draft') {
    if (!confirm(`Void ${inv.number}? It will stay in the list as voided.`)) return;
    await patchInvoice(id, { status: 'void' });
    invSelection.delete(id);
    renderInvoicesPage();
    toast(`${inv.number} voided`, 'success');
    return;
  }
  if (!confirm(`Delete ${inv.number}? This cannot be undone.`)) return;
  await deleteInvoiceRecord(id);
  invSelection.delete(id);
  renderInvoicesPage();
  toast('Invoice deleted', 'success');
}

// Duplicate from a list row → v2 flow: clone the payload into a new
// draft (numberless) and open it in the editor.
function duplicateInvoiceFromList(id) {
  duplicateInvoiceToDraft(id);
}

// Legacy "Duplicate this invoice" button still present in the static
// #invoice-status-section markup. That section is hidden in draft mode
// and innerHTML-replaced in detail mode, so this is effectively dead —
// but keep it functional (clone the current editor form into a new
// draft) to avoid a ReferenceError if it's ever reached.
function duplicateCurrentInvoice() {
  const data = collectData();
  delete data.invoice_number;
  const d = newDraft(data);
  openDraft(d.local_id);
  toast('Duplicated into a new draft', 'success');
}

// + New invoice from the invoices list header. v2 flow: create a fresh
// draft and route to it. The old startNewInvoice() / goToInvoice() pair
// is dead code now and will be removed in step 10's cleanup.
function newInvoiceFromList() {
  newDraftWithLastCompany();
}

// Light in-place reset: clear bindings + draft, blank the form fields, pull
// a fresh invoice number, drop a single empty line. No full reload required.
async function startNewInvoice() {
  setEditorMode('new');
  currentInvoiceStatus = 'draft';
  currentInvoicePaidDate = null;
  clearDraft();
  resetEditorForm();
  try {
    localStorage.removeItem('inv_next_number');
    await loadInvoiceNumber();
  } catch {}
  recalc();
  if (typeof renderInvoiceStatus === 'function') renderInvoiceStatus();
}

// Blank the editor form back to a fresh-draft state. Does NOT touch the
// invoice number — caller decides whether to bump it.
function resetEditorForm() {
  // Buyer + seller fields
  ['b-name','b-addr','b-phone','b-email','s-name','s-addr','s-phone','s-email','notes']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const nt = document.getElementById('b-net-terms'); if (nt) nt.value = 30;
  selCustId = null;
  selCompId = null;
  // Reset toggles
  const chkDisc = document.getElementById('chk-discount'); if (chkDisc) chkDisc.checked = false;
  const chkInvDisc = document.getElementById('chk-invoice-disc');
  if (chkInvDisc) { chkInvDisc.checked = false; if (typeof toggleInvoiceDiscount === 'function') toggleInvoiceDiscount(); }
  const chkDue = document.getElementById('chk-due'); if (chkDue) { chkDue.checked = false; if (typeof toggleDue === 'function') toggleDue(); }
  const chkInd = document.getElementById('chk-individual-disclaimer'); if (chkInd) chkInd.checked = false;
  // Reset dates
  const today = new Date().toISOString().slice(0, 10);
  const due   = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const d  = document.getElementById('inv-date'); if (d) d.value = today;
  const dd = document.getElementById('inv-due');  if (dd) dd.value = due;
  // Reset items to one empty row
  const body = document.getElementById('items-body');
  if (body) {
    body.innerHTML = '';
    rowCount = 0;
    if (typeof addRow === 'function') addRow();
  }
  if (typeof toggleDiscount === 'function') toggleDiscount();
}

// Editor sidebar: delete the bound record + reset the form to a fresh draft.
async function deleteCurrentInvoice() {
  if (editor.mode !== 'editing' || !editor.invoiceId) return;
  const bound = invoices.find(r => r.id === editor.invoiceId);
  const label = bound?.number || 'this invoice';
  const eff = bound ? effectiveInvoiceStatus(bound) : 'draft';
  // Issued/paid records get voided instead of hard-deleted (Part A7).
  if (bound && eff !== 'draft') {
    if (!confirm(`Void ${label}? It will stay in the list as voided.`)) return;
    await patchInvoice(editor.invoiceId, { status: 'void' });
    setEditorMode('new');
    await startNewInvoice();
    toast(`${label} voided`, 'success');
    return;
  }
  if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
  const idToDelete = editor.invoiceId;
  // Clear bindings BEFORE the delete so the autosave fires don't write the
  // record back under the same id.
  setEditorMode('new');
  await deleteInvoiceRecord(idToDelete);
  await startNewInvoice();
  toast(`${label} deleted`, 'success');
}

// Defensive check: the inv-num input listener only catches USER-typed
// changes; programmatic `.value = …` writes bypass it. If we ever render
// the banner while the field and editor.boundNumber disagree, the binding
// is stale — unbind so the next Generate doesn't patch the wrong record.
// Called at the end of renderEditingBanner so every banner render
// double-checks consistency.
function reconcileEditorBinding() {
  if (editor.mode !== 'editing') return false;
  if (!editor.boundNumber) return false;
  const fieldValue = (document.getElementById('inv-num')?.value || '').trim();
  if (!fieldValue) return false;
  if (fieldValue !== editor.boundNumber) {
    setEditorMode('new');   // recursive but safe — mode is now 'new', no re-entry
    return true;
  }
  return false;
}

// "Editing INV-068" banner — visible only when the form is bound to a saved
// record. The number field stays editable; the banner just labels the link.
function renderEditingBanner() {
  const banner = document.getElementById('editing-banner');
  const num    = document.getElementById('editing-banner-number');
  const delBtn = document.getElementById('editor-delete-btn');
  if (!banner) return;
  // Defensive: if field and boundNumber disagree, break the binding first.
  // reconcileEditorBinding() calls setEditorMode('new') which re-enters
  // this function — the next call will hit the else branch and hide.
  if (reconcileEditorBinding()) return;
  if (editor.mode === 'editing' && editor.invoiceId && editor.boundNumber) {
    banner.hidden = false;
    if (num) num.textContent = editor.boundNumber;
    if (delBtn) {
      const bound = invoices.find(r => r.id === editor.invoiceId);
      const eff = bound ? effectiveInvoiceStatus(bound) : 'draft';
      delBtn.hidden = false;
      delBtn.textContent = eff === 'draft' ? 'Delete' : 'Void';
    }
  } else {
    banner.hidden = true;
    if (delBtn) delBtn.hidden = true;
  }
}

// Renders the editing-mode "Save changes" button. Enabled only when
// editor.dirty === true. Wired by index.html (#editor-save-btn).
function renderEditingSaveButton() {
  const btn = document.getElementById('editor-save-btn');
  if (!btn) return;
  if (editor.mode === 'editing' && editor.invoiceId) {
    btn.hidden = false;
    btn.disabled = !editor.dirty;
  } else {
    btn.hidden = true;
  }
}

// ── Bulk selection ────────────────────────────────────────────────────────
function toggleRowSelected(id, checked) {
  if (checked) invSelection.add(id); else invSelection.delete(id);
  const row = document.querySelector(`.invoice-row[data-id="${id}"]`);
  if (row) row.classList.toggle('selected', checked);
  updateBulkBar();
}
function updateBulkBar() {
  const bar = document.getElementById('invoices-bulkbar');
  const cnt = document.getElementById('invoices-bulkbar-count');
  if (!bar || !cnt) return;
  const n = invSelection.size;
  bar.hidden = n === 0;
  cnt.textContent = `${n} selected`;
}
async function bulkMarkPaid() {
  const ids = Array.from(invSelection);
  let ok = 0;
  for (const id of ids) { try { await patchInvoice(id, { status: 'paid' }); ok++; } catch {} }
  invSelection.clear();
  renderInvoicesPage();
  toast(`${ok} marked paid`, 'success');
}
async function bulkDuplicate() {
  const ids = Array.from(invSelection);
  let made = 0;
  for (const id of ids) {
    const inv = invoices.find(r => r.id === id);
    if (!inv) continue;
    // v2 model: duplicates are local drafts (numberless), not server
    // rows. Each becomes a fresh draft seeded from the source payload.
    const seed = JSON.parse(JSON.stringify(inv.payload || {}));
    delete seed.invoice_number;
    seed.date = new Date().toISOString().slice(0, 10);
    delete seed.due_date;
    const d = newDraft(seed);
    if (inv.customer_id) drafts[d.local_id].customer_id = inv.customer_id;
    if (inv.company_id)  drafts[d.local_id].company_id  = inv.company_id;
    made++;
  }
  persistDraftsNow();
  invSelection.clear();
  renderInvoicesPage();
  toast(`Created ${made} draft${made === 1 ? '' : 's'} from selection`, 'success');
}
async function bulkDelete() {
  const ids = Array.from(invSelection);
  const selected = invoices.filter(r => ids.includes(r.id));
  const drafts  = selected.filter(r => effectiveInvoiceStatus(r) === 'draft');
  const issued  = selected.filter(r => effectiveInvoiceStatus(r) !== 'draft');
  const parts = [];
  if (drafts.length) parts.push(`delete ${drafts.length} draft${drafts.length === 1 ? '' : 's'}`);
  if (issued.length) parts.push(`void ${issued.length} issued/paid`);
  if (!parts.length) return;
  if (!confirm(`This will ${parts.join(' and ')}. Continue?`)) return;
  for (const inv of drafts) await deleteInvoiceRecord(inv.id);
  for (const inv of issued) { try { await patchInvoice(inv.id, { status: 'void' }); } catch {} }
  invSelection.clear();
  renderInvoicesPage();
  const summary = [
    drafts.length ? `${drafts.length} deleted` : null,
    issued.length ? `${issued.length} voided` : null,
  ].filter(Boolean).join(', ');
  toast(summary, 'success');
}

// ── CSV export (suggestion 6) ─────────────────────────────────────────────
function exportInvoicesCsv() {
  const rows = pipelineInvoices();
  if (rows.length === 0) { toast('Nothing to export', 'error'); return; }
  const header = ['number','date','due_date','buyer','currency','total','status','paid_at','issued_age_days'];
  const csvLines = [header.join(',')];
  const today = new Date();
  rows.forEach(r => {
    const eff = effectiveInvoiceStatus(r);
    const issuedAge = r.date ? Math.floor((today - new Date(r.date + 'T00:00:00')) / 864e5) : '';
    const cells = [
      r.number || '',
      r.date || '',
      r.due_date || '',
      r.buyer?.name || '',
      r.currency || '',
      Number(r.total || 0).toFixed(2),
      eff,
      r.paid_at ? r.paid_at.slice(0, 10) : '',
      issuedAge,
    ].map(v => {
      const s = String(v).replace(/"/g, '""');
      return /[,\"\n]/.test(s) ? `"${s}"` : s;
    });
    csvLines.push(cells.join(','));
  });
  const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `invoices-${today.toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${rows.length} rows`, 'success');
}

// ── Customer detail page ─────────────────────────────────────────────────
function goToCustomer(customerId) {
  if (!customerId) return;
  location.hash = '#/customers/' + encodeURIComponent(customerId);
}
function goToInvoiceList() { location.hash = '#/invoices'; }

// "View invoice history →" link in the buyer block. Only useful when a
// saved customer is selected; show a toast otherwise.
function goToCustomerForCurrentBuyer() {
  if (selCustId) { goToCustomer(selCustId); return; }
  toast('Save this client first to see their history', 'error');
}

// Tracks the currently-viewed customer detail. Used by the "+ New
// invoice for this customer" button on the detail page.
let _currentCustomerDetailId = null;

function renderCustomerDetail(customerId) {
  _currentCustomerDetailId = customerId;
  const cust = (customers || []).find(c => c.id === customerId);
  const invs = (invoices || []).filter(r => r.customer_id === customerId);
  document.getElementById('customer-detail-name').textContent = cust?.name || 'Customer';
  document.getElementById('customer-detail-meta').textContent = cust ? (cust.email || cust.phone || '') : '';
  const stats = document.getElementById('customer-stats');
  const list  = document.getElementById('customer-invoices-list');
  // Totals
  const cur = invs[0]?.currency || 'USD';
  const totalInvoiced = invs.reduce((s, r) => s + Number(r.total || 0), 0);
  const outstanding = invs
    .filter(r => effectiveInvoiceStatus(r) === 'issued' || effectiveInvoiceStatus(r) === 'overdue')
    .reduce((s, r) => s + Number(r.total || 0), 0);
  const paidCount = invs.filter(r => r.status === 'paid').length;
  const paidWithDate = invs.filter(r => r.status === 'paid' && r.paid_at && r.date);
  let avgDaysToPay = '—';
  if (paidWithDate.length) {
    const sum = paidWithDate.reduce((s, r) => s + Math.max(0, Math.floor((new Date(r.paid_at) - new Date(r.date + 'T00:00:00')) / 864e5)), 0);
    avgDaysToPay = Math.round(sum / paidWithDate.length) + ' days';
  }
  stats.innerHTML = `
    <div class="customer-stat"><span class="label">Total invoiced</span><span class="value">${fmtMoney(totalInvoiced, cur)}</span></div>
    <div class="customer-stat"><span class="label">Outstanding</span><span class="value outstanding">${fmtMoney(outstanding, cur)}</span></div>
    <div class="customer-stat"><span class="label">Paid invoices</span><span class="value paid">${paidCount}</span></div>
    <div class="customer-stat"><span class="label">Avg days to pay</span><span class="value">${avgDaysToPay}</span></div>`;
  if (invs.length === 0) {
    list.innerHTML = `<div class="invoices-empty"><strong>No invoices for this customer yet.</strong></div>`;
    return;
  }
  list.innerHTML = invs.map(rowHtml).join('');
}

// "+ New invoice" button on the customer detail page.
async function newInvoiceForCurrentCustomer() {
  if (!_currentCustomerDetailId) { toast('No customer selected', 'error'); return; }
  await startNewInvoiceForCustomer(_currentCustomerDetailId);
}

// Seed a NEW v2 draft with a saved customer's contact details, then
// route to that draft. Used by detail-page action button +
// "duplicate to same customer" flows.
function startNewInvoiceForCustomer(customerId) {
  const c = (customers || []).find(x => x.id === customerId);
  const seed = c ? {
    buyer: {
      name:    c.name || '',
      address: c.address || '',
      phone:   c.phone || '',
      email:   c.email || '',
      net_terms_days: c.net_terms_days ?? 30,
    },
  } : {};
  const d = newDraft(seed);
  // Stash the customer id so the issued invoice links back correctly.
  if (customerId) {
    drafts[d.local_id].customer_id = customerId;
    persistDraftsNow();
  }
  openDraft(d.local_id);
}

// ──────────────────────────────────────────────────────────────────────
// CUSTOMERS LIST PAGE — every saved buyer with totals + status mix
// ──────────────────────────────────────────────────────────────────────

// Per-customer rollup from the invoices list. Returns
// { totalInvoiced, outstanding, lastDate, byStatus: {draft, issued, paid, overdue, void}, currency }.
function customerRollup(customerId) {
  const invs = (invoices || []).filter(r => r.customer_id === customerId);
  const byStatus = { draft: 0, issued: 0, paid: 0, overdue: 0, void: 0 };
  let totalInvoiced = 0;
  let outstanding = 0;
  let lastDate = '';
  let currency = 'USD';
  invs.forEach(r => {
    const eff = effectiveInvoiceStatus(r);
    byStatus[eff] = (byStatus[eff] || 0) + 1;
    if (eff !== 'void') {
      totalInvoiced += Number(r.total) || 0;
      if (eff === 'issued' || eff === 'overdue') outstanding += Number(r.total) || 0;
    }
    if (r.date && r.date > lastDate) lastDate = r.date;
    if (r.currency) currency = r.currency;
  });
  return { totalInvoiced, outstanding, lastDate, byStatus, currency, count: invs.length };
}

function renderCustomersPage() {
  const list = document.getElementById('customers-list');
  if (!list) return;
  const search = (document.getElementById('customers-search')?.value || '').trim().toLowerCase();
  const sort   = document.getElementById('customers-sort')?.value || 'outstanding_desc';

  let rows = (customers || []).map(c => ({ ...c, _r: customerRollup(c.id) }));
  if (search) {
    rows = rows.filter(c => {
      const hay = `${c.name || ''} ${c.email || ''} ${c.phone || ''}`.toLowerCase();
      return hay.includes(search);
    });
  }
  rows.sort((a, b) => {
    if (sort === 'name_asc')         return (a.name || '').localeCompare(b.name || '');
    if (sort === 'total_desc')       return b._r.totalInvoiced - a._r.totalInvoiced;
    if (sort === 'recent_desc')      return String(b._r.lastDate).localeCompare(String(a._r.lastDate));
    return b._r.outstanding - a._r.outstanding;   // outstanding_desc (default)
  });

  const sub = document.getElementById('customers-list-sub');
  if (sub) sub.textContent = `${customers.length} customer${customers.length === 1 ? '' : 's'} · ${rows.length} shown`;

  if (rows.length === 0) {
    list.innerHTML = `<div class="invoices-empty">
      <strong>${customers.length === 0 ? 'No customers saved yet.' : 'No matches.'}</strong><br>
      ${customers.length === 0 ? 'Save a buyer from the editor to populate this list.' : 'Adjust the search.'}
    </div>`;
    return;
  }

  list.innerHTML = rows.map(c => {
    const r = c._r;
    const mixHtml = ['paid', 'issued', 'overdue', 'draft'].map(s => {
      const n = r.byStatus[s] || 0;
      if (!n) return '';
      return `<span class="chip">${n} ${s}</span>`;
    }).filter(Boolean).join('');
    const outstandingClass = r.outstanding > 0 ? 'outstanding' : 'zero';
    return `
      <div class="customer-card" onclick="goToCustomer('${escapeHtml(c.id)}')">
        <div class="customer-card-name">
          <strong>${escapeHtml(c.name || '(unnamed)')}</strong>
          <span class="meta">${escapeHtml([c.email, c.phone].filter(Boolean).join(' · ') || '—')}</span>
        </div>
        <div class="customer-card-num">
          <span class="label">Total</span>
          <span class="value">${fmtMoney(r.totalInvoiced, r.currency)}</span>
        </div>
        <div class="customer-card-num">
          <span class="label">Outstanding</span>
          <span class="value ${outstandingClass}">${fmtMoney(r.outstanding, r.currency)}</span>
        </div>
        <div class="customer-card-mix">${mixHtml || `<span class="chip">${r.count} total</span>`}</div>
        <div class="customer-card-actions" onclick="event.stopPropagation()">
          <button class="ghost-btn" type="button" onclick="startNewInvoiceForCustomer('${escapeHtml(c.id)}')">+ Invoice</button>
        </div>
      </div>`;
  }).join('');
}

// "+ New customer" button on the customers list — open a new draft
// with focus in the buyer name field so the user can type and save.
// (Saving a customer doesn't require issuance — the Save button on
// the buyer combo writes to the customers table directly.)
function newCustomerFromList() {
  const d = newDraft({});
  openDraft(d.local_id);
  setTimeout(() => {
    document.getElementById('b-name')?.focus();
  }, 50);
}

// ──────────────────────────────────────────────────────────────────────
// COMPANIES LIST + DETAIL — pivot invoices by seller company
// ──────────────────────────────────────────────────────────────────────

// Match invoices to a company. Primary key is company_id (set by new
// records after the schema migration). Older rows without it fall back
// to fuzzy name match on payload.seller.name. Match is case-insensitive
// trim — sufficient for display, never used as a write key.
function invoicesForCompany(company) {
  const id = company?.id;
  const nameKey = (company?.name || '').trim().toLowerCase();
  return (invoices || []).filter(r => {
    if (id && r.company_id === id) return true;
    if (r.company_id) return false;   // explicitly linked elsewhere
    if (!nameKey) return false;
    const sellerName = String(r.payload?.seller?.name || r.seller?.name || '').trim().toLowerCase();
    return sellerName === nameKey;
  });
}

function companyRollup(company) {
  return rollupForInvoices(invoicesForCompany(company));
}

// Invoices issued with NO company — the "Individual / no company"
// bucket. A row counts as individual when it has no company_id link
// AND no seller name in its payload. Pre-migration rows (no company_id)
// with an empty seller fall in here too.
function individualInvoices() {
  return (invoices || []).filter(r => {
    if (r.company_id) return false;
    const sellerName = String(r.payload?.seller?.name || r.seller?.name || '').trim();
    return sellerName === '';
  });
}

function rollupForInvoices(invs) {
  const byStatus = { draft: 0, issued: 0, paid: 0, overdue: 0, void: 0 };
  let totalBilled = 0;
  let outstanding = 0;
  let lastDate = '';
  let currency = 'USD';
  invs.forEach(r => {
    const eff = effectiveInvoiceStatus(r);
    byStatus[eff] = (byStatus[eff] || 0) + 1;
    if (eff !== 'void') {
      totalBilled += Number(r.total) || 0;
      if (eff === 'issued' || eff === 'overdue') outstanding += Number(r.total) || 0;
    }
    if (r.date && r.date > lastDate) lastDate = r.date;
    if (r.currency) currency = r.currency;
  });
  return { totalBilled, outstanding, lastDate, byStatus, currency, count: invs.length, invs };
}

// Start a fresh draft with NO seller/company — an individual invoice.
// Clears any seller fields so the PDF prints without a company header,
// and clears the remembered company so subsequent new invoices stay
// individual until the user picks a company again.
function startIndividualInvoice() {
  rememberLastCompany(null);
  const d = newDraft({ seller: { name: '', address: '', phone: '', email: '' } });
  openDraft(d.local_id);
}

function renderCompaniesPage() {
  const list = document.getElementById('companies-list');
  if (!list) return;
  const search = (document.getElementById('companies-search')?.value || '').trim().toLowerCase();

  let rows = (companies || []).map(c => ({ ...c, _r: companyRollup(c) }));
  if (search) {
    rows = rows.filter(c => {
      const hay = `${c.name || ''} ${c.email || ''} ${c.phone || ''}`.toLowerCase();
      return hay.includes(search);
    });
  }
  rows.sort((a, b) => b._r.totalBilled - a._r.totalBilled);

  const sub = document.getElementById('companies-list-sub');
  if (sub) sub.textContent = `${companies.length} company profile${companies.length === 1 ? '' : 's'} · ${rows.length} shown`;

  // Pinned "Individual / no company" card — always first, always present
  // (it's the default seller). Hidden only when a search term excludes it.
  const showIndividual = !search || 'individual no company'.includes(search);
  const ir = rollupForInvoices(individualInvoices());
  const individualCard = showIndividual ? `
    <div class="customer-card company-individual" onclick="openCompanies()" style="cursor:default">
      <div class="customer-card-name">
        <strong>Individual / no company</strong>
        <span class="meta">Invoice as yourself — no company header on the PDF</span>
      </div>
      <div class="customer-card-num">
        <span class="label">Billed</span>
        <span class="value">${fmtMoney(ir.totalBilled, ir.currency)}</span>
      </div>
      <div class="customer-card-num">
        <span class="label">Outstanding</span>
        <span class="value ${ir.outstanding > 0 ? 'outstanding' : 'zero'}">${fmtMoney(ir.outstanding, ir.currency)}</span>
      </div>
      <div class="customer-card-mix"><span class="chip">${ir.count} total</span></div>
      <div class="customer-card-actions" onclick="event.stopPropagation()">
        <button class="ghost-btn" type="button" onclick="startIndividualInvoice()">+ Invoice</button>
      </div>
    </div>` : '';

  if (rows.length === 0) {
    list.innerHTML = individualCard + `<div class="invoices-empty">
      <strong>${companies.length === 0 ? 'No company profiles yet.' : 'No matches.'}</strong><br>
      ${companies.length === 0 ? 'Add a seller profile in Settings → Companies, or invoice as an individual above.' : 'Adjust the search.'}
    </div>`;
    return;
  }

  list.innerHTML = individualCard + rows.map(c => {
    const r = c._r;
    const mixHtml = ['paid', 'issued', 'overdue', 'draft'].map(s => {
      const n = r.byStatus[s] || 0;
      if (!n) return '';
      return `<span class="chip">${n} ${s}</span>`;
    }).filter(Boolean).join('');
    const outstandingClass = r.outstanding > 0 ? 'outstanding' : 'zero';
    return `
      <div class="customer-card" onclick="goToCompany('${escapeHtml(c.id)}')">
        <div class="customer-card-name">
          <strong>${escapeHtml(c.name || '(unnamed)')}</strong>
          <span class="meta">${escapeHtml([c.email, c.phone].filter(Boolean).join(' · ') || '—')}</span>
        </div>
        <div class="customer-card-num">
          <span class="label">Billed</span>
          <span class="value">${fmtMoney(r.totalBilled, r.currency)}</span>
        </div>
        <div class="customer-card-num">
          <span class="label">Outstanding</span>
          <span class="value ${outstandingClass}">${fmtMoney(r.outstanding, r.currency)}</span>
        </div>
        <div class="customer-card-mix">${mixHtml || `<span class="chip">${r.count} total</span>`}</div>
        <div class="customer-card-actions" onclick="event.stopPropagation()">
          <button class="ghost-btn" type="button" onclick="startNewInvoiceForCompany('${escapeHtml(c.id)}')">+ Invoice</button>
        </div>
      </div>`;
  }).join('');
}

function goToCompany(companyId) {
  if (!companyId) return;
  location.hash = '#/companies/' + encodeURIComponent(companyId);
}

// Tracks the currently-viewed company detail. Used by the "+ New
// invoice" button on the detail page.
let _currentCompanyDetailId = null;

function renderCompanyDetail(companyId) {
  _currentCompanyDetailId = companyId;
  const company = (companies || []).find(c => c.id === companyId);
  const r = companyRollup(company);
  document.getElementById('company-detail-name').textContent = company?.name || 'Company';
  document.getElementById('company-detail-meta').textContent = company
    ? [company.email, company.phone].filter(Boolean).join(' · ')
    : '';
  const stats = document.getElementById('company-stats');
  const list  = document.getElementById('company-invoices-list');
  const paidWithDate = r.invs.filter(x => x.status === 'paid' && x.paid_at && x.date);
  let avgDaysToPay = '—';
  if (paidWithDate.length) {
    const sum = paidWithDate.reduce((s, x) =>
      s + Math.max(0, Math.floor((new Date(x.paid_at) - new Date(x.date + 'T00:00:00')) / 864e5)), 0);
    avgDaysToPay = Math.round(sum / paidWithDate.length) + ' days';
  }
  stats.innerHTML = `
    <div class="customer-stat"><span class="label">Total billed</span><span class="value">${fmtMoney(r.totalBilled, r.currency)}</span></div>
    <div class="customer-stat"><span class="label">Outstanding</span><span class="value outstanding">${fmtMoney(r.outstanding, r.currency)}</span></div>
    <div class="customer-stat"><span class="label">Invoices</span><span class="value">${r.count}</span></div>
    <div class="customer-stat"><span class="label">Avg days to pay</span><span class="value">${avgDaysToPay}</span></div>`;
  if (r.invs.length === 0) {
    list.innerHTML = `<div class="invoices-empty"><strong>No invoices issued from this company yet.</strong></div>`;
    return;
  }
  list.innerHTML = r.invs.map(rowHtml).join('');
}

async function newInvoiceForCurrentCompany() {
  if (!_currentCompanyDetailId) { toast('No company selected', 'error'); return; }
  await startNewInvoiceForCompany(_currentCompanyDetailId);
}

function startNewInvoiceForCompany(companyId) {
  const c = (companies || []).find(x => x.id === companyId);
  const seed = c ? {
    seller: {
      name:    c.name || '',
      address: c.address || '',
      phone:   c.phone || '',
      email:   c.email || '',
    },
    individual_disclaimer: !!c.individual_disclaimer,
  } : {};
  const d = newDraft(seed);
  if (companyId) {
    drafts[d.local_id].company_id = companyId;
    persistDraftsNow();
    rememberLastCompany(companyId);   // default future new invoices to this company
  }
  openDraft(d.local_id);
}

function editCurrentCompanyInSettings() {
  if (!_currentCompanyDetailId) { toast('No company selected', 'error'); return; }
  settingsCompanyId = _currentCompanyDetailId;
  openSettings('companies');
}

// ──────────────────────────────────────────────────────────────────────
// FINANCIAL DASHBOARD — totals, monthly breakdown, top customers
// ──────────────────────────────────────────────────────────────────────

const FINANCIAL_PERIOD_KEY = 'inv_financial_period';

function getFinancialPeriodChoice() {
  return localStorage.getItem(FINANCIAL_PERIOD_KEY) || 'year';
}
function setFinancialPeriodChoice(value) {
  localStorage.setItem(FINANCIAL_PERIOD_KEY, value);
}

// Translate a period selector value into a {from, to} ISO date pair.
// Both bounds are inclusive. `null` means unbounded on that side.
function resolveFinancialPeriod(choice) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const firstOfMonth = (year, month) => iso(new Date(year, month, 1));
  const lastOfMonth  = (year, month) => iso(new Date(year, month + 1, 0));
  switch (choice) {
    case 'month':       return { from: firstOfMonth(y, m),     to: lastOfMonth(y, m),     label: 'This month' };
    case 'last_month':  return { from: firstOfMonth(y, m - 1), to: lastOfMonth(y, m - 1), label: 'Last month' };
    case 'quarter': {
      const qStart = Math.floor(m / 3) * 3;
      return { from: firstOfMonth(y, qStart), to: lastOfMonth(y, qStart + 2), label: 'This quarter' };
    }
    case 'all':         return { from: null, to: null, label: 'All time' };
    case 'year':
    default:            return { from: `${y}-01-01`, to: `${y}-12-31`, label: 'This year' };
  }
}

function invoicesInPeriod(period) {
  return (invoices || []).filter(r => {
    if (!r.date) return false;
    if (period.from && r.date < period.from) return false;
    if (period.to   && r.date > period.to)   return false;
    return true;
  });
}

// Sum non-voided invoices in the period, by currency.
function financialTotalsByCurrency(period) {
  const rows = invoicesInPeriod(period);
  const out = {};
  rows.forEach(inv => {
    const eff = effectiveInvoiceStatus(inv);
    if (eff === 'void') return;
    const cur = inv.currency || 'USD';
    const total = Number(inv.total) || 0;
    if (!out[cur]) out[cur] = { total: 0, paid: 0, outstanding: 0, overdue: 0, count: 0 };
    out[cur].total += total;
    out[cur].count += 1;
    if (eff === 'paid') out[cur].paid += total;
    if (eff === 'issued' || eff === 'overdue') out[cur].outstanding += total;
    if (eff === 'overdue') out[cur].overdue += total;
  });
  return out;
}

// Group invoices by year-month within the period, summing paid +
// outstanding per currency. Returns array sorted desc by month.
function monthlyBreakdown(period) {
  const rows = invoicesInPeriod(period);
  const buckets = new Map();   // key 'YYYY-MM' → { paid: {USD: 0...}, outstanding: {...} }
  rows.forEach(inv => {
    const eff = effectiveInvoiceStatus(inv);
    if (eff === 'void') return;
    const month = (inv.date || '').slice(0, 7);   // YYYY-MM
    if (!month) return;
    if (!buckets.has(month)) buckets.set(month, { paid: {}, outstanding: {} });
    const b = buckets.get(month);
    const cur = inv.currency || 'USD';
    const total = Number(inv.total) || 0;
    if (eff === 'paid') b.paid[cur] = (b.paid[cur] || 0) + total;
    if (eff === 'issued' || eff === 'overdue') b.outstanding[cur] = (b.outstanding[cur] || 0) + total;
  });
  const out = Array.from(buckets.entries()).map(([month, b]) => ({ month, ...b }));
  out.sort((a, b) => b.month.localeCompare(a.month));
  return out;
}

// Top N buyers by total billed in the period (non-void only).
function topCustomersInPeriod(period, limit = 10) {
  const rows = invoicesInPeriod(period);
  const buckets = new Map();   // key (customer_id || name) → { name, totals: {cur: 0}, count }
  rows.forEach(inv => {
    const eff = effectiveInvoiceStatus(inv);
    if (eff === 'void') return;
    const name = inv.buyer?.name || '(no buyer)';
    const key = inv.customer_id || `name:${name.toLowerCase()}`;
    if (!buckets.has(key)) buckets.set(key, { name, customerId: inv.customer_id, totals: {}, count: 0 });
    const b = buckets.get(key);
    const cur = inv.currency || 'USD';
    const total = Number(inv.total) || 0;
    b.totals[cur] = (b.totals[cur] || 0) + total;
    b.count += 1;
  });
  const arr = Array.from(buckets.values());
  arr.sort((a, b) => {
    const aSum = Object.values(a.totals).reduce((s, x) => s + x, 0);
    const bSum = Object.values(b.totals).reduce((s, x) => s + x, 0);
    return bSum - aSum;
  });
  return arr.slice(0, limit);
}

function monthLabel(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number);
  if (!y || !m) return yyyyMm;
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${names[m - 1]} ${y}`;
}

function renderFinancialPage() {
  const body = document.getElementById('financial-page-body');
  if (!body) return;
  const choice = getFinancialPeriodChoice();
  const period = resolveFinancialPeriod(choice);
  const totals = financialTotalsByCurrency(period);
  const currencies = Object.keys(totals);
  const monthly = monthlyBreakdown(period);
  const topCustomers = topCustomersInPeriod(period, 10);

  // Tiles — show per-currency rows when more than one currency is in use.
  const tile = (label, getValue, klass = '') => {
    if (currencies.length === 0) {
      return `<div class="financial-tile ${klass}"><span class="label">${label}</span><div class="amounts"><span class="amount muted">—</span></div></div>`;
    }
    const amounts = currencies.map(cur => `<span class="amount">${fmtMoney(getValue(cur), cur)}</span>`).join('');
    return `<div class="financial-tile ${klass}"><span class="label">${label}</span><div class="amounts">${amounts}</div></div>`;
  };

  const tilesHtml = `
    <div class="financial-tiles">
      ${tile('Total',       cur => totals[cur].total)}
      ${tile('Paid',        cur => totals[cur].paid,        'paid')}
      ${tile('Outstanding', cur => totals[cur].outstanding, 'outstanding')}
      ${tile('Overdue',     cur => totals[cur].overdue,     'overdue')}
    </div>`;

  let monthlyHtml;
  if (monthly.length === 0) {
    monthlyHtml = `<div class="financial-empty">No invoices in this period.</div>`;
  } else {
    monthlyHtml = `<div class="financial-rows">${monthly.map(m => {
      const paidStr = Object.entries(m.paid).map(([c, v]) => fmtMoney(v, c)).join(' · ') || '—';
      const outStr  = Object.entries(m.outstanding).map(([c, v]) => fmtMoney(v, c)).join(' · ') || '—';
      return `
        <div class="financial-row">
          <span class="row-label">${monthLabel(m.month)}</span>
          <span class="row-amounts">
            <span class="paid">${paidStr} paid</span>
            <span class="outstanding">${outStr} outstanding</span>
          </span>
        </div>`;
    }).join('')}</div>`;
  }

  let topHtml;
  if (topCustomers.length === 0) {
    topHtml = `<div class="financial-empty">No buyers in this period.</div>`;
  } else {
    topHtml = `<div class="financial-rows">${topCustomers.map((c, i) => {
      const totalStr = Object.entries(c.totals).map(([cur, v]) => fmtMoney(v, cur)).join(' · ');
      const clickAttr = c.customerId
        ? `onclick="goToCustomer('${escapeHtml(c.customerId)}')" style="cursor:pointer"`
        : '';
      return `
        <div class="financial-row" ${clickAttr}>
          <span class="row-label">${i + 1}. ${escapeHtml(c.name)}</span>
          <span class="row-amounts">
            <span>${totalStr}</span>
            <span style="color:var(--text3); font-weight:400">${c.count} invoice${c.count === 1 ? '' : 's'}</span>
          </span>
        </div>`;
    }).join('')}</div>`;
  }

  let byCurrencyHtml = '';
  if (currencies.length > 0) {
    byCurrencyHtml = `
      <section class="financial-section">
        <h3>By currency</h3>
        <div class="financial-rows">${currencies.map(cur => `
          <div class="financial-row">
            <span class="row-label">${escapeHtml(cur)}</span>
            <span class="row-amounts">
              <span>${fmtMoney(totals[cur].total, cur)}</span>
              <span style="color:var(--text3); font-weight:400">${totals[cur].count} invoice${totals[cur].count === 1 ? '' : 's'}</span>
            </span>
          </div>`).join('')}</div>
      </section>`;
  }

  body.innerHTML = `
    <header class="financial-head">
      <h1>Financial overview</h1>
      <div class="financial-period">
        <select id="financial-period-select" onchange="onFinancialPeriodChange()">
          <option value="month">This month</option>
          <option value="last_month">Last month</option>
          <option value="quarter">This quarter</option>
          <option value="year">This year</option>
          <option value="all">All time</option>
        </select>
      </div>
    </header>

    ${tilesHtml}

    <section class="financial-section">
      <h3>Monthly breakdown · ${escapeHtml(period.label)}</h3>
      ${monthlyHtml}
    </section>

    <section class="financial-section">
      <h3>Top customers · ${escapeHtml(period.label)}</h3>
      ${topHtml}
    </section>

    ${byCurrencyHtml}
  `;

  // Restore the selected period in the dropdown (innerHTML replaced it).
  const sel = document.getElementById('financial-period-select');
  if (sel) sel.value = choice;
}

function onFinancialPeriodChange() {
  const sel = document.getElementById('financial-period-select');
  if (!sel) return;
  setFinancialPeriodChoice(sel.value);
  renderFinancialPage();
}

// Mobile gear-equivalent for the list icon.
function toggleInvoicesRoute() {
  if (location.hash.startsWith('#/invoices')) goToInvoice();
  else openInvoices();
}

// ─────────────────────────────────────────────────────────────────────────
// HOME PAGE — landing dashboard with tiles + recent activity
// ─────────────────────────────────────────────────────────────────────────

// Sum non-voided invoices, bucketed by currency.
// Returns { [currency]: { total, paid, outstanding, overdue, count } }.
function summarizeAllInvoices(list) {
  const out = {};
  (list || []).forEach(inv => {
    const eff = effectiveInvoiceStatus(inv);
    if (eff === 'void') return;
    const cur = inv.currency || 'USD';
    const total = Number(inv.total) || 0;
    if (!out[cur]) out[cur] = { total: 0, paid: 0, outstanding: 0, overdue: 0, count: 0 };
    out[cur].total += total;
    out[cur].count += 1;
    if (eff === 'paid') out[cur].paid += total;
    if (eff === 'issued' || eff === 'overdue') out[cur].outstanding += total;
    if (eff === 'overdue') out[cur].overdue += total;
  });
  return out;
}

// Top N most recent history events across the invoice list.
// Returns [{at, from, to, inv}] sorted by `at` desc.
function recentActivity(list, limit = 6) {
  const events = [];
  (list || []).forEach(inv => {
    const history = Array.isArray(inv.history) ? inv.history : [];
    history.forEach(h => {
      if (!h?.at) return;
      events.push({ at: h.at, from: h.from || '', to: h.to || '', inv });
    });
  });
  events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return events.slice(0, limit);
}

function humanTimeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  if (isNaN(then)) return '';
  const diff = (Date.now() - then.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 2) return 'yesterday';
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} days ago`;
  return iso.slice(0, 10);
}

function homeTileSvg(name) {
  // Tiny inline icons — matches the topbar SVG style (stroke-only, 1.7w).
  const ICONS = {
    plus:     '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    list:     '<line x1="8" y1="6"  x2="20" y2="6"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="8" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    user:     '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
    briefcase:'<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    chart:    '<line x1="4" y1="20" x2="20" y2="20"/><line x1="6" y1="16" x2="6" y2="11"/><line x1="11" y1="16" x2="11" y2="7"/><line x1="16" y1="16" x2="16" y2="13"/>',
    gear:     '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.2-1.7l2-1.5-2-3.4-2.3.9a7 7 0 0 0-3-1.7L13 2h-2l-.5 2.6a7 7 0 0 0-3 1.7L5.2 5.4l-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .6.1 1.1.2 1.7l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 3 1.7L11 22h2l.5-2.6a7 7 0 0 0 3-1.7l2.3.9 2-3.4-2-1.5c.1-.6.2-1.1.2-1.7Z"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="20" height="20" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function renderHomePage() {
  const body = document.getElementById('home-page-body');
  if (!body) return;
  const summary = summarizeAllInvoices(invoices);
  const currencies = Object.keys(summary);
  const isSignedIn = supabaseActive();
  const greeting = isSignedIn ? authDisplayName() : 'there';

  // Hero stat line — pick the dominant currency, or compact "n invoices"
  // when nothing is recorded yet.
  let heroStats = '';
  if (currencies.length === 0) {
    heroStats = `<div class="home-hero-stats"><span>No invoices yet — generate one to get started.</span></div>`;
  } else {
    const primary = currencies.sort((a, b) => summary[b].total - summary[a].total)[0];
    const s = summary[primary];
    const totalCount = currencies.reduce((sum, c) => sum + summary[c].count, 0);
    heroStats = `
      <div class="home-hero-stats">
        <span><strong>${totalCount}</strong> invoice${totalCount === 1 ? '' : 's'}</span>
        <span class="sep">·</span>
        <span><strong>${fmtMoney(s.outstanding, primary)}</strong> outstanding</span>
        ${s.overdue > 0 ? `<span class="sep">·</span><span style="color:#dc2626"><strong>${fmtMoney(s.overdue, primary)}</strong> overdue</span>` : ''}
        ${currencies.length > 1 ? `<span class="sep">·</span><span style="color:var(--text3)">+${currencies.length - 1} other currency</span>` : ''}
      </div>`;
  }

  // Activity list — last 6 status changes.
  const events = recentActivity(invoices, 6);
  let activityHtml;
  if (events.length === 0) {
    activityHtml = `<div class="home-activity-empty">No activity yet. Status changes will appear here.</div>`;
  } else {
    activityHtml = `<div class="home-activity-list">${events.map(e => {
      const num = escapeHtml(e.inv.number || '');
      const buyer = escapeHtml(e.inv.buyer?.name || '');
      const dest = encodeURIComponent(e.inv.id || '');
      return `
        <a class="home-activity-item" href="javascript:void(0)" onclick="openInvoiceFromList('${dest}')">
          <span class="dot"></span>
          <span><strong>${num}</strong> → ${escapeHtml(e.to)}${buyer ? ` · ${buyer}` : ''}</span>
          <span class="when">${escapeHtml(humanTimeAgo(e.at))}</span>
        </a>`;
    }).join('')}</div>`;
  }

  body.innerHTML = `
    <section class="home-hero">
      <h2>Hi ${escapeHtml(greeting)}.</h2>
      ${heroStats}
    </section>

    <div class="home-tile-grid">
      <button class="home-tile primary" type="button" onclick="newInvoiceFromHome()">
        <span class="home-tile-icon">${homeTileSvg('plus')}</span>
        <h3>New invoice</h3>
        <p>Start a fresh draft and generate a PDF.</p>
      </button>
      <button class="home-tile" type="button" onclick="openInvoices()">
        <span class="home-tile-icon">${homeTileSvg('list')}</span>
        <h3>Invoices</h3>
        <p>All drafts, issued, paid, and overdue.</p>
      </button>
      <button class="home-tile" type="button" onclick="openCustomers()">
        <span class="home-tile-icon">${homeTileSvg('user')}</span>
        <h3>Customers</h3>
        <p>Buyer list with outstanding totals.</p>
      </button>
      <button class="home-tile" type="button" onclick="openCompanies()">
        <span class="home-tile-icon">${homeTileSvg('briefcase')}</span>
        <h3>Companies</h3>
        <p>Your seller profiles and what they've issued.</p>
      </button>
      <button class="home-tile" type="button" onclick="openFinancial()">
        <span class="home-tile-icon">${homeTileSvg('chart')}</span>
        <h3>Financial</h3>
        <p>Outstanding, paid, overdue — at a glance.</p>
      </button>
      <button class="home-tile" type="button" onclick="openSettings()">
        <span class="home-tile-icon">${homeTileSvg('gear')}</span>
        <h3>Settings</h3>
        <p>Workspace defaults and seller profiles.</p>
      </button>
    </div>

    <section class="home-section">
      <h3>Recent activity</h3>
      ${activityHtml}
    </section>`;
}

// "+ New invoice" tile on home — fresh draft, pre-seeded with the
// last company the user invoiced under (if any).
function newInvoiceFromHome() {
  newDraftWithLastCompany();
}

// bootInvoicePreload: removed in the redraft. Invoices are now loaded
// synchronously in DOMContentLoaded so the Home / Drafts / Issue
// next-number compute all see the authoritative list before the user
// can act. Routes that need the latest list (Home, list pages,
// detail) re-fetch on enter.

