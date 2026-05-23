const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const BASE = __dirname;
const OUT = process.env.INVOICE_OUTPUT_DIR || path.join(BASE, "data", "output");
const TEMPLATE = path.join(BASE, "template_meridian.html");

const ONES_EN = ["","one","two","three","four","five","six","seven","eight","nine","ten",
  "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
const TENS_EN = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];
const ONES_AR = ["","\u0648\u0627\u062d\u062f","\u0627\u062b\u0646\u0627\u0646","\u062b\u0644\u0627\u062b\u0629","\u0623\u0631\u0628\u0639\u0629","\u062e\u0645\u0633\u0629","\u0633\u062a\u0629","\u0633\u0628\u0639\u0629","\u062b\u0645\u0627\u0646\u064a\u0629","\u062a\u0633\u0639\u0629","\u0639\u0634\u0631\u0629",
  "\u0623\u062d\u062f \u0639\u0634\u0631","\u0627\u062b\u0646\u0627 \u0639\u0634\u0631","\u062b\u0644\u0627\u062b\u0629 \u0639\u0634\u0631","\u0623\u0631\u0628\u0639\u0629 \u0639\u0634\u0631","\u062e\u0645\u0633\u0629 \u0639\u0634\u0631","\u0633\u062a\u0629 \u0639\u0634\u0631","\u0633\u0628\u0639\u0629 \u0639\u0634\u0631","\u062b\u0645\u0627\u0646\u064a\u0629 \u0639\u0634\u0631","\u062a\u0633\u0639\u0629 \u0639\u0634\u0631"];
const TENS_AR = ["","","\u0639\u0634\u0631\u0648\u0646","\u062b\u0644\u0627\u062b\u0648\u0646","\u0623\u0631\u0628\u0639\u0648\u0646","\u062e\u0645\u0633\u0648\u0646","\u0633\u062a\u0648\u0646","\u0633\u0628\u0639\u0648\u0646","\u062b\u0645\u0627\u0646\u0648\u0646","\u062a\u0633\u0639\u0648\u0646"];
const CUR_EN = { USD:{m:"US Dollars",f:"Cents"}, LBP:{m:"Lebanese Pounds",f:"Piastres"} };
const CUR_AR = { USD:{m:"\u062f\u0648\u0644\u0627\u0631 \u0623\u0645\u0631\u064a\u0643\u064a",f:"\u0633\u0646\u062a"}, LBP:{m:"\u0644\u064a\u0631\u0629 \u0644\u0628\u0646\u0627\u0646\u064a\u0629",f:"\u0642\u0631\u0634"} };

function n2wEn(n) {
  n = Math.round(n);
  if (n === 0) return "zero";
  if (n < 20) return ONES_EN[n];
  if (n < 100) return TENS_EN[Math.floor(n / 10)] + (n % 10 ? " " + ONES_EN[n % 10] : "");
  if (n < 1000) return ONES_EN[Math.floor(n / 100)] + " hundred" + (n % 100 ? " " + n2wEn(n % 100) : "");
  if (n < 1e6) return n2wEn(Math.floor(n / 1000)) + " thousand" + (n % 1000 ? " " + n2wEn(n % 1000) : "");
  return n2wEn(Math.floor(n / 1e6)) + " million" + (n % 1e6 ? " " + n2wEn(n % 1e6) : "");
}

function n2wAr(n) {
  n = Math.round(n);
  if (n === 0) return "\u0635\u0641\u0631";
  if (n < 20) return ONES_AR[n];
  if (n < 100) return TENS_AR[Math.floor(n / 10)] + (n % 10 ? " \u0648" + ONES_AR[n % 10] : "");
  if (n < 1000) return ONES_AR[Math.floor(n / 100)] + " \u0645\u0626\u0629" + (n % 100 ? " \u0648" + n2wAr(n % 100) : "");
  if (n < 1e6) return n2wAr(Math.floor(n / 1000)) + " \u0623\u0644\u0641" + (n % 1000 ? " \u0648" + n2wAr(n % 1000) : "");
  return n2wAr(Math.floor(n / 1e6)) + " \u0645\u0644\u064a\u0648\u0646" + (n % 1e6 ? " \u0648" + n2wAr(n % 1e6) : "");
}

function amountWords(amount, cur) {
  const intP = Math.floor(amount);
  const decP = Math.round((amount - intP) * 100);
  const en = CUR_EN[cur] || { m: cur, f: "Cents" };
  const ar = CUR_AR[cur] || { m: cur, f: "\u0633\u0646\u062a" };
  let enW = n2wEn(intP) + " " + en.m + (decP > 0 ? " and " + n2wEn(decP) + " " + en.f : "");
  enW = enW.charAt(0).toUpperCase() + enW.slice(1) + " Only";
  const arW = n2wAr(intP) + " " + ar.m + (decP > 0 ? " \u0648" + n2wAr(decP) + " " + ar.f : "");
  return { en: enW, ar: arW + " \u0641\u0642\u0637" };
}

function calcTotals(items, vatPct, includeDiscount = true) {
  let subtotal = 0;
  let totalDisc = 0;
  const rows = items.map((it) => {
    const qty = Number(it.qty) || 0;
    const unitPrice = Number(it.unit_price) || 0;
    const discountPct = includeDiscount ? (Number(it.discount_pct) || 0) : 0;
    const gross = qty * unitPrice;
    const discAmt = gross * (discountPct / 100);
    const net = gross - discAmt;
    subtotal += gross;
    totalDisc += discAmt;
    return { ...it, qty, unit_price: unitPrice, discount_pct: discountPct, gross, discAmt, net };
  });
  const netSub = subtotal - totalDisc;
  const vatAmt = netSub * ((Number(vatPct) || 0) / 100);
  const grand = netSub + vatAmt;
  return { rows, subtotal, totalDisc, netSub, vatAmt, grand };
}

const fmt = (n) => Number(n || 0).toLocaleString("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hasArabic(value) {
  return /[\u0600-\u06ff]/.test(String(value || ""));
}

function biLabel(lang, en, ar) {
  if (lang === "ar") return ar;
  if (lang === "bi") return `${en} / ${ar}`;
  return en;
}

function moneyCell(amount, cur) {
  const symbol = cur === "USD" ? "$" : "LBP";
  return `<span class="amount-cell"><span class="symbol">${esc(symbol)}</span><span class="value">${fmt(amount)}</span></span>`;
}

function partyBlock(label, party) {
  const lines = ["address", "phone", "email"]
    .filter((key) => party[key])
    .map((key) => `<p class="party-line" dir="auto">${esc(party[key])}</p>`)
    .join("");
  return `<p class="party-label">${esc(label)}</p><p class="party-name" dir="auto">${esc(party.name || "\u2014")}</p>${lines}`;
}

function companyHeader(seller) {
  if (!seller.name) return "";
  const lines = ["address", "phone", "email"]
    .filter((key) => seller[key])
    .map((key) => `<p class="company-line" dir="auto">${esc(seller[key])}</p>`)
    .join("");
  const titleClass = hasArabic(seller.name) ? "company-name arabic-title" : "company-name";
  return `<h2 class="${titleClass}" dir="auto">${esc(seller.name)}</h2>${lines}`;
}

function logoHtml(seller) {
  if (!seller.logo_path) return "";
  const logoPath = path.isAbsolute(seller.logo_path) ? seller.logo_path : path.join(BASE, seller.logo_path);
  if (!fs.existsSync(logoPath)) return "";
  const ext = path.extname(logoPath).slice(1).toLowerCase() || "png";
  const mime = ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
  const data = fs.readFileSync(logoPath).toString("base64");
  return `<img class="company-logo" alt="" src="data:${mime};base64,${data}">`;
}

function safeFilename(value) {
  return String(value || "INV-001").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function findLocalBrowser() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function renderTemplate(data) {
  const lang = ["en", "ar", "bi"].includes(data.language) ? data.language : "bi";
  const cur = data.currency === "LBP" ? "LBP" : "USD";
  const seller = data.seller || {};
  const buyer = data.buyer || {};
  const totals = calcTotals(data.items || [], data.vat_pct || 0, data.include_discount !== false);
  const words = amountWords(totals.grand, cur);
  const showDiscount = totals.totalDisc > 0;
  const vatPct = Number(data.vat_pct) || 0;
  const notes = (data.notes || "").trim() || "\u2014";
  const invoiceWord = lang === "ar" ? "\u0641\u0627\u062a\u0648\u0631\u0629" : (lang === "bi" ? "INVOICE / \u0641\u0627\u062a\u0648\u0631\u0629" : "INVOICE");
  const bodyClass = `lang-${lang}`;

  const rowsHtml = totals.rows.map((row, index) => `
    <tr>
      <td>${String(index + 1).padStart(2, "0")}</td>
      <td dir="auto">${esc(row.description || "")}</td>
      <td>${fmt(row.qty)}</td>
      <td>${moneyCell(row.unit_price, cur)}</td>
      <td>${esc(fmt(row.discount_pct) + "%")}</td>
      <td>${moneyCell(row.net, cur)}</td>
    </tr>`).join("");

  const dueHtml = data.due_date
    ? `<div class="meta-item"><label>${esc(biLabel(lang, "Due Date", "\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0627\u0633\u062a\u062d\u0642\u0627\u0642"))}</label><strong>${esc(data.due_date)}</strong></div>`
    : "";
  const sellerParty = seller.name
    ? `<div class="party party-from">${partyBlock(biLabel(lang, "FROM", "\u0645\u0646"), seller)}</div>`
    : "";
  const discountTotalHtml = showDiscount
    ? `<div class="total-row discount"><span>${esc(biLabel(lang, "Discount", "\u0627\u0644\u062e\u0635\u0645"))}</span><strong>- ${cur} ${fmt(totals.totalDisc)}</strong></div>`
    : "";
  const vatTotalHtml = vatPct > 0
    ? `<div class="total-row"><span>${esc(biLabel(lang, `VAT (${fmt(vatPct).replace(/\.00$/, "")}%)`, `\u0636\u0631\u064a\u0628\u0629 (${fmt(vatPct).replace(/\.00$/, "")}%)`))}</span><strong>${cur} ${fmt(totals.vatAmt)}</strong></div>`
    : "";

  const replacements = {
    HTML_LANG: lang === "ar" ? "ar" : "en",
    HTML_DIR: lang === "ar" ? "rtl" : "ltr",
    BODY_CLASS: bodyClass,
    DOC_TITLE: `Invoice ${data.invoice_number || "INV-001"}`,
    LOGO_HTML: logoHtml(seller),
    SELLER_HEADER_HTML: companyHeader(seller),
    INVOICE_WORD: invoiceWord,
    INVOICE_NUMBER: esc(data.invoice_number || "INV-001"),
    ISSUED_LABEL: esc(biLabel(lang, "Issued", "\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0625\u0635\u062f\u0627\u0631")),
    DATE: esc(data.date || ""),
    INVOICE_DATE_LABEL: esc(biLabel(lang, "Invoice Date", "\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0641\u0627\u062a\u0648\u0631\u0629")),
    DUE_DATE_HTML: dueHtml,
    CURRENCY_LABEL: esc(biLabel(lang, "Currency", "\u0627\u0644\u0639\u0645\u0644\u0629")),
    CURRENCY: esc(cur),
    BUYER_HTML: partyBlock(biLabel(lang, "BILLED TO", "\u0625\u0644\u0649"), buyer),
    SELLER_PARTY_HTML: sellerParty,
    DESCRIPTION_LABEL: esc(biLabel(lang, "Description", "\u0627\u0644\u0648\u0635\u0641")),
    QTY_LABEL: esc(biLabel(lang, "Qty", "\u0627\u0644\u0643\u0645\u064a\u0629")),
    UNIT_PRICE_LABEL: esc(biLabel(lang, "Unit Price", "\u0633\u0639\u0631 \u0627\u0644\u0648\u062d\u062f\u0629")),
    DISCOUNT_LABEL: esc(biLabel(lang, "Disc%", "\u062e\u0635\u0645")),
    AMOUNT_LABEL: esc(biLabel(lang, "Amount", "\u0627\u0644\u0645\u062c\u0645\u0648\u0639")),
    ROWS_HTML: rowsHtml,
    NOTES_LABEL: esc(biLabel(lang, "Notes", "\u0645\u0644\u0627\u062d\u0638\u0627\u062a")),
    NOTES_DIR: lang === "ar" || hasArabic(notes) ? "rtl" : "auto",
    NOTES_TEXT: esc(notes),
    SUBTOTAL_LABEL: esc(biLabel(lang, "Subtotal", "\u0627\u0644\u0645\u062c\u0645\u0648\u0639 \u0627\u0644\u0641\u0631\u0639\u064a")),
    SUBTOTAL: `${cur} ${fmt(totals.subtotal)}`,
    DISCOUNT_TOTAL_HTML: discountTotalHtml,
    VAT_TOTAL_HTML: vatTotalHtml,
    TOTAL_LABEL: esc(biLabel(lang, "Total", "\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a")),
    GRAND_TOTAL: `${cur} ${fmt(totals.grand)}`,
    WORDS_EN: esc(words.en),
    WORDS_AR: esc(words.ar),
  };

  let html = fs.readFileSync(TEMPLATE, "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    html = html.replaceAll(`{{${key}}}`, value);
  }
  return html;
}

async function buildAndSavePDF(data) {
  fs.mkdirSync(OUT, { recursive: true });
  const html = renderTemplate(data);
  const filename = `invoice_${safeFilename(data.invoice_number)}.pdf`;
  const outPath = path.join(OUT, filename);
  let browser;
  try {
    const executablePath = findLocalBrowser();
    browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({
      path: outPath,
      format: "A4",
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    process.stdout.write(outPath);
  } finally {
    if (browser) await browser.close();
  }
}

let raw = "";
process.stdin.on("data", (d) => raw += d);
process.stdin.on("end", async () => {
  try {
    const data = JSON.parse(raw || "{}");
    await buildAndSavePDF(data);
  } catch (err) {
    process.stderr.write(err && err.stack ? err.stack : String(err));
    process.exit(1);
  }
});
