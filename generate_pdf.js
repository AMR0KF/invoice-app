const fs = require("fs");
const path = require("path");
const isVercel = !!process.env.VERCEL;
const puppeteer = isVercel ? require("puppeteer-core") : require("puppeteer");
const chromium = isVercel ? require("@sparticuz/chromium") : null;

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

function normalizeTemplate(value) {
  const allowed = ["aurora", "meridian", "meridian_v2", "obsidian", "classic"];
  return allowed.includes(value) ? value : "aurora";
}

function moneyCompact(n) {
  return fmt(n).replace(/\.00$/, "");
}

function moneyWithCurrency(amount, cur) {
  return `${cur} ${fmt(amount)}`;
}

function legacyPartyBlock(label, party) {
  const lines = [`<h3>${esc(label)}</h3>`, `<strong dir="auto">${esc(party.name || "")}</strong>`];
  for (const key of ["address", "phone", "email"]) {
    if (party[key]) lines.push(`<span dir="auto">${esc(party[key])}</span>`);
  }
  return lines.join("\n");
}

function invoiceNotes(data, lang) {
  const notes = (data.notes || "").trim() || "Payment due within 1 week.";
  if (!data.individual_disclaimer) return notes;
  const lines = [];
  if (lang === "en" || lang === "bi") lines.push("Invoice issued by an independent individual for services rendered.");
  if (lang === "ar" || lang === "bi") lines.push("\u0641\u0627\u062a\u0648\u0631\u0629 \u0635\u0627\u062f\u0631\u0629 \u0639\u0646 \u0641\u0631\u062f \u0645\u0633\u062a\u0642\u0644 \u0645\u0642\u0627\u0628\u0644 \u062e\u062f\u0645\u0627\u062a \u0645\u0642\u062f\u0645\u0629.");
  return `${notes}\n${lines.join("\n")}`;
}

function renderLegacyTemplate(data, template) {
  const lang = ["en", "ar", "bi"].includes(data.language) ? data.language : "bi";
  const cur = data.currency === "LBP" ? "LBP" : "USD";
  const curSymbol = cur === "USD" ? "$" : cur;
  const seller = data.seller || {};
  const buyer = data.buyer || {};
  const totals = calcTotals(data.items || [], data.vat_pct || 0, data.include_discount !== false);
  const invoiceNo = esc(data.invoice_number || "INV-001");
  const date = esc(data.date || "");
  const due = data.due_date || "";
  const invoiceTitle = biLabel(lang, "Invoice", "\u0641\u0627\u062a\u0648\u0631\u0629");
  const fromLabel = biLabel(lang, "FROM", "\u0645\u0646");
  const billToLabel = biLabel(lang, "BILL TO", "\u0625\u0644\u0649");
  const thDesc = biLabel(lang, "DESCRIPTION", "\u0627\u0644\u0648\u0635\u0641");
  const thQty = biLabel(lang, "QTY", "\u0627\u0644\u0643\u0645\u064a\u0629");
  const thUnit = biLabel(lang, "UNIT PRICE", "\u0633\u0639\u0631 \u0627\u0644\u0648\u062d\u062f\u0629");
  const thAmount = biLabel(lang, "AMOUNT", "\u0627\u0644\u0645\u062c\u0645\u0648\u0639");
  const thDisc = biLabel(lang, "DISC.", "\u062e\u0635\u0645");
  const subtotalLabel = biLabel(lang, "Subtotal", "\u0627\u0644\u0645\u062c\u0645\u0648\u0639 \u0627\u0644\u0641\u0631\u0639\u064a");
  const discountLabel = biLabel(lang, "Discount", "\u0627\u0644\u062e\u0635\u0645");
  const totalLabel = biLabel(lang, "Total", "\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a");
  const notesTitle = biLabel(lang, "NOTES", "\u0645\u0644\u0627\u062d\u0638\u0627\u062a");
  const showDiscount = totals.totalDisc > 0;
  const sellerName = seller.name || "Company";
  const sellerNameClass = hasArabic(sellerName) ? "company-title arabic-title" : "company-title";
  const sellerNameDir = hasArabic(sellerName) ? "rtl" : "auto";
  const dueCard = due ? `<section><small>${esc(biLabel(lang, "DUE DATE", "\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0627\u0633\u062a\u062d\u0642\u0627\u0642"))}</small><strong>${esc(due)}</strong></section>` : "";
  const metaBlock = dueCard ? `<div class="meta">${dueCard}</div>` : "";
  const discountHead = showDiscount ? `<th>${esc(thDisc)}</th>` : "";
  const discountTotal = showDiscount ? `<div><span>${esc(discountLabel)}</span><strong>${esc(moneyWithCurrency(totals.totalDisc, cur))}</strong></div>` : "";
  const vatPct = Number(data.vat_pct) || 0;
  const vatTotal = vatPct > 0 ? `<div><span>VAT (${moneyCompact(vatPct)}%)</span><strong>${esc(moneyWithCurrency(totals.vatAmt, cur))}</strong></div>` : "";
  const thankEn = lang === "en" || lang === "bi" ? "Thank you for your business!" : "";
  const thankAr = lang === "ar" || lang === "bi" ? "\u0634\u0643\u0631\u0627\u064b \u0644\u062a\u0639\u0627\u0645\u0644\u0643\u0645 \u0645\u0639\u0646\u0627" : "";

  const rows = totals.rows.map((item, idx) => {
    const discountCell = showDiscount ? `<td>${moneyCompact(item.discount_pct)}%</td>` : "";
    return `<tr>
      <td>${String(idx + 1).padStart(2, "0")}</td>
      <td dir="auto">${esc(item.description || "")}</td>
      <td>${moneyCompact(item.qty)}</td>
      <td><span class="money-cell"><span class="money-symbol">${esc(curSymbol)}</span><span>${fmt(item.unit_price)}</span></span></td>
      ${discountCell}
      <td><span class="money-cell"><span class="money-symbol">${esc(curSymbol)}</span><span>${fmt(item.net)}</span></span></td>
    </tr>`;
  }).join("");

  const notesHtml = invoiceNotes(data, lang).split(/\r?\n/).map((line) => {
    const ar = hasArabic(line);
    return `<span class="${ar ? "note-line ar-note" : "note-line"}" dir="${ar ? "rtl" : "auto"}">${esc(line)}</span>`;
  }).join("");

  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<title>Invoice ${invoiceNo}</title>
<style>
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
body {
  --paper: #ffffff;
  --ink: #101828;
  --muted: #667085;
  --brand: #756bff;
  --brand-strong: #5f55ee;
  --line: #d9ddff;
  --soft: #fbfaff;
  margin: 0;
  background: #eef0f4;
  color: var(--ink);
  font-family: Arial, sans-serif;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
body.meridian {
  --paper: #fffdf8;
  --ink: #111827;
  --muted: #667085;
  --brand: #b88a3d;
  --brand-strong: #8d6729;
  --line: #e8dcc4;
  --soft: #fff8ea;
}
body.obsidian {
  --paper: #ffffff;
  --ink: #111827;
  --muted: #667085;
  --brand: #334155;
  --brand-strong: #111827;
  --line: #d7dde8;
  --soft: #f7f9fc;
}
body.classic {
  --paper: #ffffff;
  --ink: #111827;
  --muted: #6b7280;
  --brand: #111827;
  --brand-strong: #111827;
  --line: #d1d5db;
  --soft: #f9fafb;
}
body.aurora {
  --line: #dfe4ff;
  --soft: #f8f7ff;
}
[dir="auto"], [dir="rtl"], .arabic { unicode-bidi: plaintext; }
[dir="rtl"], .arabic { direction: rtl; font-family: "Arabic Typesetting", "Traditional Arabic", Tahoma, Arial, sans-serif; }
.page { width: 210mm; min-height: 297mm; margin: 0 auto; background: var(--paper); padding: 18mm; position: relative; overflow: hidden; }
body.aurora .page { padding-top: 0; }
body.aurora .hero { position: relative; z-index: 1; height: 38mm; margin: 0 -18mm 8mm; padding: 9mm 18mm 0; background: linear-gradient(105deg, #e2e8ff 0%, #eee9ff 50%, #fde8f6 100%); display: flex; justify-content: space-between; align-items: flex-start; }
body.aurora .hero:after {
  content: "";
  position: absolute;
  left: 18mm;
  right: 18mm;
  bottom: 3mm;
  height: 3mm;
  background: #ffffff;
  opacity: .96;
  clip-path: polygon(0 62%, 16% 55%, 32% 47%, 48% 43%, 64% 49%, 82% 57%, 100% 51%, 100% 100%, 0 100%);
}
body.aurora .meta,
body.aurora .parties,
body.aurora table,
body.aurora .bottom,
body.aurora .thanks-footer,
body.aurora footer { position: relative; z-index: 2; }
body.meridian .page { border-left: 2mm solid var(--brand); padding: 18mm 18mm 16mm 18mm; }
body.obsidian .page { border-left: 18mm solid #111827; }
.brand { display: flex; gap: 4mm; align-items: center; min-height: 12mm; }
.company-title { margin: 0; font-size: 14pt; }
.arabic-title { font-family: "Arabic Typesetting", "Traditional Arabic", Tahoma, Arial, sans-serif; font-size: 28pt; line-height: 1; font-weight: 700; }
.brand p, .invoice-id p { margin: 1mm 0 0; color: var(--muted); font-size: 8pt; }
.invoice-id { text-align: right; }
.invoice-id h2 { margin: 0; color: var(--brand-strong); font-size: 22pt; }
body.aurora .invoice-id h2 { color: #1e1b4b; font-size: 18pt; }
body.aurora .company-title { font-size: 14pt; }
body.aurora .arabic-title { font-size: 28pt; }
body.aurora .invoice-id p { color: #635bff; font-size: 7.5pt; }
.meridian-head { display: none; }
body.meridian .meridian-head, body.obsidian .meridian-head, body.classic .meridian-head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--line); padding-bottom: 10mm; margin-bottom: 8mm; }
body.meridian .meridian-head { border-bottom-color: var(--line); }
body.meridian .meridian-head .invoice-id p:first-child { color: var(--brand); font-size: 8pt; letter-spacing: .1em; font-weight: 800; }
body.meridian .hero, body.obsidian .hero, body.classic .hero { display: none; }
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(42mm, 1fr)); gap: 3mm; margin: 8mm 0 7mm; }
.meta section { border: 1px solid var(--line); border-radius: 2mm; padding: 4mm; background: var(--soft); }
body.meridian .meta { border-bottom: 1px solid var(--line); padding-bottom: 7mm; }
body.meridian .meta section { background: transparent; border: 0; padding: 0; }
small, .section-title { color: var(--brand); font-size: 7.5pt; font-weight: 800; letter-spacing: .08em; }
.meta strong { display: block; margin-top: 2mm; font-size: 10pt; }
.parties { display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; margin-bottom: 8mm; }
.party { border: 1px solid #edf0f4; border-radius: 2mm; padding: 5mm; min-height: 24mm; }
body.aurora .parties { gap: 4mm; margin-top: 0; margin-bottom: 8mm; }
body.aurora .party {
  min-height: 25mm;
  border: 1px solid #dfe4ff;
  border-radius: 5mm;
  padding: 4.5mm 5mm;
  background: linear-gradient(180deg, #ffffff 0%, #fbfbff 100%);
  box-shadow: 0 4mm 10mm rgba(99, 91, 255, .08);
}
body.aurora .party h3 { color: #635bff; font-size: 7.2pt; margin-bottom: 2.2mm; }
body.aurora .party strong { display: block; color: #111827; font-size: 11pt; line-height: 1.25; margin-bottom: 1.5mm; }
body.aurora .party span { color: #475467; font-size: 8pt; line-height: 1.45; }
body.meridian .parties { border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 6mm 0; margin-bottom: 9mm; }
body.meridian .party { border: 0; border-radius: 0; padding: 0; min-height: 18mm; }
.party h3 { margin: 0 0 2mm; color: var(--brand); font-size: 7.5pt; letter-spacing: .08em; }
.party strong { display: block; color: var(--ink); }
.party span { display: block; color: var(--muted); font-size: 8pt; margin-top: 1mm; }
table { width: 100%; border-collapse: collapse; margin-top: 5mm; }
th { color: var(--brand); font-size: 7.5pt; text-align: right; padding: 3mm 2mm; border-bottom: 1px solid var(--line); }
th:nth-child(2), td:nth-child(2) { text-align: left; }
td { font-size: 8.5pt; text-align: right; padding: 3mm 2mm; border-bottom: 1px solid #edf0f4; }
.money-cell { display: inline-flex; justify-content: flex-end; align-items: baseline; gap: .9mm; min-width: 18mm; font-variant-numeric: tabular-nums; }
.money-symbol { color: var(--ink); }
tbody tr:nth-child(odd) { background: var(--soft); }
body.meridian td { border-bottom-color: #eee4d2; }
.bottom { display: grid; grid-template-columns: 1fr 52mm; gap: 10mm; margin-top: 10mm; align-items: start; }
.notes { color: var(--muted); font-size: 8pt; line-height: 1.6; }
.note-line { display: block; text-align: left; }
.ar-note { direction: rtl; text-align: left; font-family: Arial, "Traditional Arabic", sans-serif; }
.thanks-footer { margin-top: 14mm; text-align: center; color: var(--brand); font-weight: 700; }
.thanks-footer .thanks-en { margin: 0 0 1.5mm; font-size: 11pt; }
.thanks-footer .thanks-ar { margin: 0; direction: rtl; font-family: Arial, "Traditional Arabic", sans-serif; font-size: 10pt; line-height: 1.35; font-weight: 400; }
.totals div { display: flex; justify-content: space-between; font-size: 8.5pt; padding: 2mm 0; }
.grand { margin-top: 2mm; padding: 4mm !important; border-radius: 2mm; background: var(--brand); color: white; align-items: center; }
body.meridian .grand { background: transparent; color: var(--ink); border-top: 1px solid var(--line); border-radius: 0; padding-left: 0 !important; padding-right: 0 !important; }
body.meridian .grand strong { color: var(--ink); }
.grand strong { font-size: 16pt; }
footer { position: absolute; left: 18mm; right: 18mm; bottom: 8mm; color: #c7cbd1; font-size: 7pt; display: flex; justify-content: flex-end; }
</style>
</head>
<body class="${esc(template)}">
<main class="page">
  <header class="hero">
    <div class="brand"><div><h1 class="${sellerNameClass}" dir="${sellerNameDir}">${esc(sellerName)}</h1><p dir="auto">${esc(seller.email || "")}</p></div></div>
    <div class="invoice-id"><h2>${esc(invoiceTitle)}</h2><p>${invoiceNo}</p><p>${esc(biLabel(lang, "Issued", "\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0625\u0635\u062f\u0627\u0631"))}: ${date}</p></div>
  </header>
  <header class="meridian-head">
    <div><h1 class="${sellerNameClass}" dir="${sellerNameDir}">${esc(sellerName)}</h1><p dir="auto">${esc(seller.address || "")}</p><p dir="auto">${esc(seller.email || "")}</p></div>
    <div class="invoice-id"><p>${esc(invoiceTitle.toUpperCase())}</p><h2>${invoiceNo}</h2><p>${esc(biLabel(lang, "Issued", "\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0625\u0635\u062f\u0627\u0631"))}: ${date}</p></div>
  </header>
  ${metaBlock}
  <div class="parties"><div class="party party-from">${legacyPartyBlock(fromLabel, seller)}</div><div class="party party-bill">${legacyPartyBlock(billToLabel, buyer)}</div></div>
  <table><thead><tr><th>#</th><th>${esc(thDesc)}</th><th>${esc(thQty)}</th><th>${esc(thUnit)}</th>${discountHead}<th>${esc(thAmount)}</th></tr></thead><tbody>${rows}</tbody></table>
  <section class="bottom">
    <div class="notes"><div class="section-title">${esc(notesTitle)}</div><p dir="auto">${notesHtml}</p></div>
    <div class="totals"><div><span>${esc(subtotalLabel)}</span><strong>${esc(moneyWithCurrency(totals.subtotal, cur))}</strong></div>${discountTotal}${vatTotal}<div class="grand"><span>${esc(totalLabel)}</span><strong>${esc(moneyWithCurrency(totals.grand, cur))}</strong></div></div>
  </section>
  <section class="thanks-footer">
    ${thankEn ? `<p class="thanks-en">${esc(thankEn)}</p>` : ""}
    ${thankAr ? `<p class="thanks-ar">${esc(thankAr)}</p>` : ""}
  </section>
  <footer><span>Page 1 / 1</span></footer>
</main>
</body>
</html>`;
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

async function browserLaunchOptions() {
  if (isVercel) {
    return {
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    };
  }

  const executablePath = findLocalBrowser();
  return {
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  };
}

function renderTemplate(data) {
  const lang = ["en", "ar", "bi"].includes(data.language) ? data.language : "bi";
  const template = normalizeTemplate(data.template);
  if (template !== "meridian_v2") return renderLegacyTemplate(data, template);
  const cur = data.currency === "LBP" ? "LBP" : "USD";
  const seller = data.seller || {};
  const buyer = data.buyer || {};
  const totals = calcTotals(data.items || [], data.vat_pct || 0, data.include_discount !== false);
  const words = amountWords(totals.grand, cur);
  const showDiscount = totals.totalDisc > 0;
  const vatPct = Number(data.vat_pct) || 0;
  const notes = (data.notes || "").trim() || "\u2014";
  const invoiceWord = lang === "ar" ? "\u0641\u0627\u062a\u0648\u0631\u0629" : (lang === "bi" ? "INVOICE / \u0641\u0627\u062a\u0648\u0631\u0629" : "INVOICE");
  const bodyClass = `lang-${lang} template-${template}`;

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
  const filename = `${safeFilename(data.invoice_number)}.pdf`;
  const outPath = path.join(OUT, filename);
  const buffer = await buildPDFBuffer(data);
  fs.writeFileSync(outPath, buffer);
  process.stdout.write(outPath);
}

async function buildPDFBuffer(data) {
  const html = renderTemplate(data);
  let browser;
  try {
    browser = await puppeteer.launch(await browserLaunchOptions());
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = {
  buildAndSavePDF,
  buildPDFBuffer,
  renderTemplate,
  safeFilename,
};

if (require.main === module) {
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
}
