// ── State ──────────────────────────────────────────────────────────────────
let companies  = [];
let customers  = [];
let invoices   = [];   // persisted invoice records — populated by loadInvoices().
let editingInvoiceId = null;     // when set, generating PDF updates this record
                                 // instead of creating a new one.
let editingBoundNumber = null;   // the invoice_number editingInvoiceId belongs to;
                                 // setInvoiceNumber clears the binding when the
                                 // number on screen no longer matches.
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

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Set today's date
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('inv-date').value = today;
  document.getElementById('inv-due').value  = new Date(Date.now() + 7*864e5).toISOString().split('T')[0];
  loadDocumentSettings();
  renderItemHistoryDatalist();
  // Restore FIRST so the empty-form initial recalc() can't wipe a saved draft.
  // restoreDraft itself runs with _draftRestoring=true to guard against
  // recursive saves while it's populating fields.
  const restored = restoreDraft();
  await initSupabaseAuth();
  if (!supabaseActive()) {
    toggleDiscount();
    if (!rowCount) addRow();
    await loadInvoiceNumber();
    if (!restored) restoreDraft();
    renderInvoiceStatus();
    renderEditingBanner();
    wireDraftAutosave();
    routeView();
    return;
  }
  await loadInvoiceNumber();

  await loadCompanies();
  await loadCustomers();
  toggleDiscount();
  if (!rowCount) addRow();
  if (!restored) restoreDraft();
  renderInvoiceStatus();
  wireDraftAutosave();
  routeView();
});

// Delegate listener so autosave catches every input/change in the invoice
// view (notes, buyer fields, template/lang selects, etc.) — not just the
// ones routed through recalc().
function wireDraftAutosave() {
  const view = document.getElementById('view-invoice');
  if (!view || view.dataset.autosaveWired === '1') return;
  view.addEventListener('input',  saveDraft);
  view.addEventListener('change', saveDraft);
  view.dataset.autosaveWired = '1';
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

function routeView() {
  const hash = (location.hash || '').replace(/^#/, '');
  const onSettings = hash.startsWith('/settings');
  const onInvoices = hash.startsWith('/invoices');
  const onCustomerDetail = hash.startsWith('/customers/');
  const anchor = hash.split('/')[2] || '';
  document.getElementById('view-invoice').hidden  = onSettings || onInvoices || onCustomerDetail;
  document.getElementById('view-settings').hidden = !onSettings;
  const invoicesEl = document.getElementById('view-invoices');
  if (invoicesEl) invoicesEl.hidden = !onInvoices;
  const custEl = document.getElementById('view-customer');
  if (custEl) custEl.hidden = !onCustomerDetail;
  document.body.classList.toggle('on-settings', onSettings);
  document.body.classList.toggle('on-invoices', onInvoices);
  document.body.classList.toggle('on-customer', onCustomerDetail);
  document.querySelectorAll('.topbar-nav .nav-link').forEach(el => {
    let route = 'invoice';
    if (onSettings) route = 'settings';
    else if (onInvoices) route = 'invoices';
    el.classList.toggle('active', el.dataset.route === route);
  });
  if (onInvoices) {
    // Show page chrome immediately, then load and render.
    renderInvoicesPage();
    loadInvoices().then(renderInvoicesPage).catch(() => {});
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }
  if (onCustomerDetail) {
    const cid = hash.split('/')[2] || '';
    renderCustomerDetail(cid);
    loadInvoices().then(() => renderCustomerDetail(cid)).catch(() => {});
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }
  if (!onSettings) return;
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
}

function openInvoices() {
  if (location.hash === '#/invoices') routeView(); else location.hash = '#/invoices';
}

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

// Always return to the editor regardless of where we came from.
// Used by: the "Editor" tab on the desktop nav pill, the back buttons on
// settings / invoices / customer-detail pages, and the mobile gear icon
// when already on settings. Earlier versions only handled `#/settings`,
// which silently no-op'd on the new `#/invoices` / `#/customers/<id>`
// routes — that's the reported "can't get back to the editor" bug.
function goToInvoice() {
  const hash = location.hash || '';
  if (hash && hash !== '#/' && hash !== '#') {
    location.hash = '#/';   // triggers hashchange → routeView() renders editor
    return;
  }
  // Already on the editor route (hash was empty or '#/'); hashchange won't
  // fire, so render directly. Defensive — shouldn't normally be reached.
  routeView();
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
  applyCompanyToInvoice(company);
  renderDropdown('company');
  if (showToast) toast('Company loaded on invoice', 'success');
  // The button label promises navigation ("Use on invoice"); deliver on it.
  // Internal callers pass showToast=false when they don't want the bounce
  // (e.g. silent applies during save flows).
  if (showToast) goToInvoice();
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (supabaseActive()) closeAuthModal();
    closePdfPreview();
    // Escape from any off-editor route returns to the editor. Was previously
    // gated to #/settings only — now covers #/invoices and #/customers/<id>.
    const hash = location.hash || '';
    if (hash.startsWith('#/settings') || hash.startsWith('#/invoices') || hash.startsWith('#/customers/')) {
      goToInvoice();
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
        await loadInvoiceNumber();
        await loadCompanies();
        await loadCustomers();
      } else {
        companies = [];
        customers = [];
        selCompId = null;
        selCustId = null;
        renderDropdown('company');
        renderDropdown('customer');
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
    await loadInvoiceNumber();
    await loadCompanies();
    await loadCustomers();
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

async function loadInvoiceNumber() {
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
  if (editingBoundNumber && next !== editingBoundNumber) {
    editingInvoiceId = null;
    editingBoundNumber = null;
    if (typeof renderEditingBanner === 'function') renderEditingBanner();
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
      if (!selCompId && companies.length) applyCompanyToInvoice(companies[0]);
    }
    renderDropdown('company');
    renderSettingsCompanyList();
    return;
  }

  try {
    companies = (await API('GET', '/api/companies')).map(normalizeCompany);
    if (!selCompId && companies.length) applyCompanyToInvoice(companies[0]);
    renderDropdown('company');
    renderSettingsCompanyList();
  } catch { /* server may not be running, use localStorage fallback */ 
    const stored = localStorage.getItem('inv_companies');
    companies = stored ? JSON.parse(stored).map(normalizeCompany) : [];
    if (!selCompId && companies.length) applyCompanyToInvoice(companies[0]);
    renderDropdown('company');
    renderSettingsCompanyList();
  }
}

function applyCompanyToInvoice(company) {
  if (!company) return;
  selCompId = company.id || null;
  document.getElementById('s-name').value = company.name || '';
  document.getElementById('s-addr').value = company.address || '';
  document.getElementById('s-phone').value = company.phone || '';
  document.getElementById('s-email').value = company.email || '';
  document.getElementById('chk-individual-disclaimer').checked = !!company.individual_disclaimer;
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
    const { error } = await supabaseClient
      .from('invoices')
      .update({ ...fields, history: hist })
      .eq('id', id);
    if (error) { console.warn('Invoice patch failed:', error.message); await loadInvoices(); }
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
  if (editingInvoiceId) {
    await patchInvoice(editingInvoiceId, {
      status:   record.status,
      total:    record.total,
      buyer:    record.buyer,
      seller:   record.seller,
      currency: record.currency,
      due_date: record.due_date,
      payload:  record.payload,
    });
  } else {
    const saved = await saveInvoice(record);
    if (saved?.id) {
      editingInvoiceId = saved.id;
      editingBoundNumber = saved.number || record.number;
    }
  }
  if (typeof renderEditingBanner === 'function') renderEditingBanner();
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
  saveDraft();
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
  saveDraft();
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

// ── Draft autosave ─────────────────────────────────────────────────────────
// The full invoice form is persisted to localStorage so a tab swipe / page
// reload / crashed browser doesn't wipe in-progress work. Restore runs once
// at boot; saveDraft is debounced through recalc().
const DRAFT_KEY = 'inv_draft_v1';
let _draftSaveTimer = null;
let _draftRestoring = false;

function saveDraft() {
  if (_draftRestoring) return;
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

function restoreDraft() {
  let raw; try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return false; }
  if (!raw) return false;
  let entry; try { entry = JSON.parse(raw); } catch (e) { return false; }
  const d = entry?.data; if (!d) return false;
  _draftRestoring = true;
  try {
    // Scalars
    const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
    set('inv-num',   d.invoice_number);
    set('inv-date',  d.date);
    set('currency',  d.currency);
    set('vat-pct',   d.vat_pct);
    set('invoice-template', d.template);
    set('doc-lang',  d.language);
    set('notes',     d.notes);
    // Due date toggle
    if (d.due_date) {
      const chk = document.getElementById('chk-due'); if (chk) { chk.checked = true; toggleDue(); }
      set('inv-due', d.due_date);
    }
    // Buyer / seller fields
    ['name','address','phone','email'].forEach(k => {
      set('b-' + (k === 'name' ? 'name' : k.slice(0,4)), d.buyer?.[k]);
    });
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
    if (d.include_discount) {
      const chk = document.getElementById('chk-discount'); if (chk) { chk.checked = true; toggleDiscount(); }
    }
    // Invoice-wide discount
    if (d.invoice_discount?.enabled) {
      const chk = document.getElementById('chk-invoice-disc'); if (chk) { chk.checked = true; toggleInvoiceDiscount(); }
      set('invoice-disc-type',  d.invoice_discount.type);
      set('invoice-disc-value', d.invoice_discount.value);
    }
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
    // Status (consumed by #5)
    currentInvoiceStatus   = d.status || 'draft';
    currentInvoicePaidDate = d.paid_date || null;
    if (typeof renderInvoiceStatus === 'function') renderInvoiceStatus();
  } finally {
    _draftRestoring = false;
  }
  recalc();
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
      await persistGeneratedInvoice(data.invoice_number);
      setInvoiceNumber(nextInvoiceNumber(data.invoice_number));
      rememberItems(data.items);
      toast(`${filename} ready`, 'success');
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
    await persistGeneratedInvoice(data.invoice_number);
    setInvoiceNumber(r.next_invoice_number || document.getElementById('inv-num').value);
    rememberItems(data.items);
    toast(`${r.filename} ready`, 'success');
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

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      if (response.ok) return response;
      lastError = new Error(`${endpoint} returned ${response.status}`);
    } catch (err) {
      lastError = new Error(`${endpoint} failed`);
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
const invSelection = new Set();

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
  const counts = { all: invoices.length, draft: 0, issued: 0, overdue: 0, paid: 0 };
  invoices.forEach(r => { counts[effectiveInvoiceStatus(r)] = (counts[effectiveInvoiceStatus(r)] || 0) + 1; });
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
    <div class="invoice-row${isSelected ? ' selected' : ''}" data-id="${inv.id}" onclick="openInvoiceFromList('${inv.id}')">
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
  loadInvoiceIntoEditor(inv);
  goToInvoice();   // unified back-to-editor path; handles already-on-editor case
}

function loadInvoiceIntoEditor(inv) {
  // Restore from inv.payload — same shape used by the draft restore path.
  if (!inv?.payload) return;
  editingInvoiceId = inv.id;
  editingBoundNumber = inv.number || inv.payload?.invoice_number || null;
  currentInvoiceStatus = inv.status || 'draft';
  currentInvoicePaidDate = inv.paid_at ? (inv.paid_at.slice(0, 10)) : null;
  // Reuse restoreDraft's apply path by stuffing the payload into the draft slot.
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), data: inv.payload }));
  } catch {}
  restoreDraft();
  if (typeof renderInvoiceStatus === 'function') renderInvoiceStatus();
  if (typeof renderEditingBanner === 'function') renderEditingBanner();
}

async function markInvoicePaid(id) {
  await patchInvoice(id, { status: 'paid' });
  renderInvoicesPage();
  toast('Marked paid', 'success');
}
async function markUnpaid(id) {
  await patchInvoice(id, { status: 'issued', paid_at: null });
  renderInvoicesPage();
  toast('Reverted to issued', 'success');
}
async function deleteInvoiceFromList(id) {
  const inv = invoices.find(r => r.id === id);
  if (!inv) return;
  if (!confirm(`Delete ${inv.number}? This cannot be undone.`)) return;
  await deleteInvoiceRecord(id);
  invSelection.delete(id);
  renderInvoicesPage();
  toast('Invoice deleted', 'success');
}

// Duplicate from a list row → opens the editor as a fresh draft prepopulated
// from the source invoice's payload. New number, today's date, status=draft.
async function duplicateInvoiceFromList(id) {
  const inv = invoices.find(r => r.id === id);
  if (!inv) return;
  duplicateFromPayload(inv.payload || {});
  goToInvoice();
  toast(`Duplicated ${inv.number} into a new draft`, 'success');
}

function duplicateFromPayload(payload) {
  editingInvoiceId = null;       // creating a new record on next gen
  editingBoundNumber = null;
  currentInvoiceStatus = 'draft';
  currentInvoicePaidDate = null;
  const clone = JSON.parse(JSON.stringify(payload || {}));
  // Reset the per-invoice scalars: date, due, number stay default; status reset.
  clone.invoice_number = document.getElementById('inv-num')?.value || 'INV-001';
  clone.date = new Date().toISOString().slice(0, 10);
  const net = Math.max(0, parseInt(clone.buyer?.net_terms_days ?? 30, 10) || 30);
  clone.due_date = new Date(Date.now() + net * 864e5).toISOString().slice(0, 10);
  clone.status = 'draft';
  clone.paid_date = null;
  // Reuse restoreDraft to push it into the form.
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), data: clone })); } catch {}
  restoreDraft();
  if (typeof renderInvoiceStatus === 'function') renderInvoiceStatus();
}

// Editor sidebar: "Duplicate this invoice" button.
function duplicateCurrentInvoice() {
  duplicateFromPayload(collectData());
  toast('Duplicated into a new draft', 'success');
}

// + New invoice from the list header — clear the editor for a fresh draft.
function newInvoiceFromList() {
  startNewInvoice();
  goToInvoice();
}

// Light in-place reset: clear bindings + draft, blank the form fields, pull
// a fresh invoice number, drop a single empty line. No full reload required.
async function startNewInvoice() {
  editingInvoiceId = null;
  editingBoundNumber = null;
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
  if (typeof renderEditingBanner === 'function') renderEditingBanner();
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
  if (!editingInvoiceId) return;
  const bound = invoices.find(r => r.id === editingInvoiceId);
  const label = bound?.number || 'this invoice';
  if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
  const idToDelete = editingInvoiceId;
  // Clear bindings BEFORE the delete so the autosave fires don't write the
  // record back under the same id.
  editingInvoiceId = null;
  editingBoundNumber = null;
  await deleteInvoiceRecord(idToDelete);
  await startNewInvoice();
  toast(`${label} deleted`, 'success');
}

// "Editing INV-068" banner — visible only when the form is bound to a saved
// record. The number field stays editable; the banner just labels the link.
function renderEditingBanner() {
  const banner = document.getElementById('editing-banner');
  const num    = document.getElementById('editing-banner-number');
  const delBtn = document.getElementById('editor-delete-btn');
  if (!banner) return;
  if (editingInvoiceId && editingBoundNumber) {
    banner.hidden = false;
    if (num) num.textContent = editingBoundNumber;
    if (delBtn) delBtn.hidden = false;
  } else {
    banner.hidden = true;
    if (delBtn) delBtn.hidden = true;
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
  for (const id of ids) {
    const inv = invoices.find(r => r.id === id);
    if (!inv) continue;
    // For bulk duplicate, save each as a new draft record directly — we
    // can't open the editor for every one. Instead create draft records.
    const payload = JSON.parse(JSON.stringify(inv.payload || {}));
    payload.status = 'draft';
    payload.invoice_number = nextInvoiceNumber(payload.invoice_number || 'INV-001');
    payload.date = new Date().toISOString().slice(0, 10);
    await saveInvoice({
      number: payload.invoice_number,
      status: 'draft',
      date: payload.date,
      due_date: null,
      customer_id: inv.customer_id,
      buyer: payload.buyer,
      seller: payload.seller,
      total: Number(inv.total) || 0,
      currency: payload.currency || 'USD',
      payload,
      history: [],
    });
  }
  invSelection.clear();
  renderInvoicesPage();
  toast(`Duplicated ${ids.length} invoices`, 'success');
}
async function bulkDelete() {
  const ids = Array.from(invSelection);
  if (!confirm(`Delete ${ids.length} invoice${ids.length === 1 ? '' : 's'}?`)) return;
  for (const id of ids) await deleteInvoiceRecord(id);
  invSelection.clear();
  renderInvoicesPage();
  toast(`Deleted ${ids.length}`, 'success');
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

function renderCustomerDetail(customerId) {
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

// Mobile gear-equivalent for the list icon.
function toggleInvoicesRoute() {
  if (location.hash.startsWith('#/invoices')) goToInvoice();
  else openInvoices();
}

// Preload invoices on boot so the list is ready when opened. Wrapped so a
// failure doesn't break the editor.
(async function bootInvoicePreload() {
  try {
    // Wait one tick so supabase init has a chance to complete.
    setTimeout(async () => { try { await loadInvoices(); } catch {} }, 800);
  } catch {}
})();

