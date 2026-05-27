#!/usr/bin/env node
/**
 * generate.js — Invoice DOCX Engine
 * Called by server.py with invoice data via stdin JSON
 * Outputs: data/output/INV-xxx.docx
 */

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, ShadingType, VerticalAlign,
  TabStopType, TabStopPosition, Footer, PageNumber, UnderlineType
} = require("docx");
const fs   = require("fs");
const path = require("path");

// Read data from stdin
let raw = "";
process.stdin.on("data", d => raw += d);
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(raw);
    buildAndSave(data);
  } catch (e) {
    console.error("JSON parse error:", e.message);
    process.exit(1);
  }
});

// ── COLOURS ────────────────────────────────────────────────────────────────
const C = {
  primary:    "1B3A6B",
  accent:     "2563EB",
  accentLight:"EFF6FF",
  headerText: "FFFFFF",
  rowAlt:     "F8FAFC",
  border:     "CBD5E1",
  textDark:   "0F172A",
  textMid:    "475569",
  textLight:  "94A3B8",
  success:    "16A34A",
  none:       "FFFFFF",
};

const THEMES = {
  classic: {
    primary: "1B3A6B", accent: "2563EB", accentLight: "EFF6FF", headerText: "FFFFFF",
    rowAlt: "F8FAFC", border: "CBD5E1", textDark: "0F172A", textMid: "475569", textLight: "94A3B8",
  },
  obsidian: {
    primary: "111827", accent: "4F46E5", accentLight: "EEF2FF", headerText: "FFFFFF",
    rowAlt: "F5F7FB", border: "CBD5E1", textDark: "111827", textMid: "475569", textLight: "94A3B8",
  },
  aurora: {
    primary: "EDEBFF", accent: "F8DDF2", accentLight: "F6F8FF", headerText: "1E1B4B",
    rowAlt: "FAF7FF", border: "D8DDFE", textDark: "1F2937", textMid: "667085", textLight: "98A2B3",
  },
  meridian: {
    primary: "F8F6F0", accent: "B8924B", accentLight: "FBF8F0", headerText: "1C1917",
    rowAlt: "FDFBF6", border: "D8C8A4", textDark: "1C1917", textMid: "7A6A52", textLight: "B8AA8A",
  },
};

function applyTheme(name) {
  Object.assign(C, THEMES[name] || THEMES.aurora);
}

// ── HELPERS ────────────────────────────────────────────────────────────────
const fmt = n => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const nb = () => ({ top: none(), bottom: none(), left: none(), right: none() });
const none = () => ({ style: BorderStyle.NONE, size: 0, color: C.none });
const b1 = (color = C.border) => ({ style: BorderStyle.SINGLE, size: 4, color });

const txt = (text, o = {}) => new TextRun({
  text,
  font:    o.font    || (o.ar ? "Traditional Arabic" : "Arial"),
  size:    o.size    || 20,
  bold:    o.bold    || false,
  color:   o.color   || C.textDark,
  italics: o.italic  || false,
  rtl:     o.ar      || false,
});

const hasArabic = text => /[\u0600-\u06FF]/.test(text || "");

const para = (runs, o = {}) => new Paragraph({
  alignment: o.align   || AlignmentType.LEFT,
  spacing:   o.spacing || { before: 0, after: 0 },
  border:    o.border  || undefined,
  tabStops:  o.tabs    || [],
  bidirectional: o.rtl || false,
  children:  Array.isArray(runs) ? runs : [runs],
});

const gap = (lines = 1) => new Paragraph({
  spacing: { before: 0, after: 0, line: lines * 240 },
  children: [new TextRun("")],
});

const cell = (children, o = {}) => new TableCell({
  width:         { size: o.w || 1000, type: WidthType.DXA },
  margins:       o.margins || { top: 100, bottom: 100, left: 140, right: 140 },
  shading:       { fill: o.bg || C.none, type: ShadingType.CLEAR },
  borders:       o.borders || nb(),
  verticalAlign: o.vAlign  || VerticalAlign.CENTER,
  children,
});

// ── WRITTEN AMOUNT ────────────────────────────────────────────────────────
const ONES_EN = ["","one","two","three","four","five","six","seven","eight","nine","ten",
  "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
const TENS_EN = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];
const ONES_AR = ["","واحد","اثنان","ثلاثة","أربعة","خمسة","ستة","سبعة","ثمانية","تسعة","عشرة",
  "أحد عشر","اثنا عشر","ثلاثة عشر","أربعة عشر","خمسة عشر","ستة عشر","سبعة عشر","ثمانية عشر","تسعة عشر"];
const TENS_AR = ["","","عشرون","ثلاثون","أربعون","خمسون","ستون","سبعون","ثمانون","تسعون"];

function n2wEn(n) {
  n = Math.round(n);
  if (n === 0) return "zero";
  if (n < 20)  return ONES_EN[n];
  if (n < 100) return TENS_EN[Math.floor(n/10)] + (n%10 ? " "+ONES_EN[n%10] : "");
  if (n < 1000) return ONES_EN[Math.floor(n/100)] + " hundred" + (n%100 ? " "+n2wEn(n%100) : "");
  if (n < 1e6)  return n2wEn(Math.floor(n/1000)) + " thousand" + (n%1000 ? " "+n2wEn(n%1000) : "");
  return n2wEn(Math.floor(n/1e6)) + " million" + (n%1e6 ? " "+n2wEn(n%1e6) : "");
}

function n2wAr(n) {
  n = Math.round(n);
  if (n === 0) return "صفر";
  if (n < 20)  return ONES_AR[n];
  if (n < 100) return TENS_AR[Math.floor(n/10)] + (n%10 ? " و"+ONES_AR[n%10] : "");
  if (n < 1000) return ONES_AR[Math.floor(n/100)] + " مئة" + (n%100 ? " و"+n2wAr(n%100) : "");
  if (n < 1e6)  return n2wAr(Math.floor(n/1000)) + " ألف" + (n%1000 ? " و"+n2wAr(n%1000) : "");
  return n2wAr(Math.floor(n/1e6)) + " مليون" + (n%1e6 ? " و"+n2wAr(n%1e6) : "");
}

const CUR_EN = { USD:{m:"US Dollars",f:"Cents"}, LBP:{m:"Lebanese Pounds",f:"Piastres"} };
const CUR_AR = { USD:{m:"دولار أمريكي",f:"سنت"}, LBP:{m:"ليرة لبنانية",f:"قرش"} };

function amountWords(amount, cur) {
  const intP = Math.floor(amount);
  const decP = Math.round((amount - intP) * 100);
  const en = CUR_EN[cur] || { m: cur, f: "Cents" };
  const ar = CUR_AR[cur] || { m: cur, f: "سنت" };
  let enW = n2wEn(intP) + " " + en.m + (decP > 0 ? " and " + n2wEn(decP) + " " + en.f : "");
  enW = enW.charAt(0).toUpperCase() + enW.slice(1) + " Only";
  let arW = n2wAr(intP) + " " + ar.m + (decP > 0 ? " و" + n2wAr(decP) + " " + ar.f : "");
  arW = arW + " فقط";
  return { en: enW, ar: arW };
}

// ── CALC TOTALS ────────────────────────────────────────────────────────────
function calcTotals(items, vatPct, invoiceDiscount) {
  let subtotal = 0, totalDisc = 0;
  const rows = items.map(it => {
    const gross   = it.qty * it.unit_price;
    const discAmt = gross * ((it.discount_pct || 0) / 100);
    const net     = gross - discAmt;
    subtotal  += gross;
    totalDisc += discAmt;
    return { ...it, gross, discAmt, net };
  });
  const netSub = subtotal - totalDisc;

  // Invoice-wide discount: applied between line discounts and VAT.
  const invDiscEnabled = !!(invoiceDiscount && invoiceDiscount.enabled);
  const invDiscType    = (invoiceDiscount && invoiceDiscount.type === "fixed") ? "fixed" : "pct";
  const invDiscValue   = Math.max(0, Number(invoiceDiscount && invoiceDiscount.value) || 0);
  let invDiscAmt = 0;
  if (invDiscEnabled) {
    invDiscAmt = invDiscType === "fixed" ? invDiscValue : netSub * (invDiscValue / 100);
    if (invDiscAmt > netSub) invDiscAmt = netSub;
  }
  const taxableBase = netSub - invDiscAmt;
  const vatAmt = taxableBase * (vatPct / 100);
  const grand  = taxableBase + vatAmt;
  return {
    rows, subtotal, totalDisc, netSub,
    invoiceDiscount: { enabled: invDiscEnabled, type: invDiscType, value: invDiscValue, amount: invDiscAmt },
    taxableBase, vatAmt, grand,
  };
}

// ── BUILD ──────────────────────────────────────────────────────────────────
async function buildAndSave(data) {
  applyTheme(data.template || "aurora");
  const { rows, subtotal, totalDisc, netSub, invoiceDiscount, vatAmt, grand } = calcTotals(data.items, data.vat_pct || 0, data.invoice_discount);
  const cur      = data.currency || "USD";
  const hasComp  = !!(data.seller && data.seller.name && data.seller.name.trim());
  const showDiscount = !!data.include_discount && totalDisc > 0;
  const words    = amountWords(grand, cur);

  // A4 page, 1-inch margins
  const PAGE_W  = 11906;
  const MARG    = { top: 1080, right: 1080, bottom: 1080, left: 1080 };
  const W       = PAGE_W - MARG.left - MARG.right; // 9746

  // Items table column widths
  const cW = showDiscount
    ? [480, 0, 860, 1240, 860, 1240]
    : [480, 0, 860, 1240, 1240];
  cW[1] = W - cW.reduce((a,b)=>a+b,0); // desc fills remaining

  const children = [];

  // ── HEADER BANNER ────────────────────────────────────────────────────────
  const leftW  = Math.floor(W * 0.58);
  const rightW = W - leftW;

  const headerLeftChildren = [];
  if (hasComp) {
    const sellerNameIsArabic = hasArabic(data.seller.name);
    headerLeftChildren.push(
      para([txt(data.seller.name, {
        size: sellerNameIsArabic ? 56 : 26,
        bold: true,
        color: C.headerText,
        font: sellerNameIsArabic ? "Arabic Typesetting" : undefined,
        ar: sellerNameIsArabic,
      })], { align: sellerNameIsArabic ? AlignmentType.RIGHT : AlignmentType.LEFT, rtl: sellerNameIsArabic }),
      gap(0.3),
    );
    if (data.seller.address) headerLeftChildren.push(para([txt(data.seller.address, { size: 16, color: "B0C4DE" })]));
    if (data.seller.phone)   headerLeftChildren.push(para([txt(data.seller.phone,   { size: 16, color: "B0C4DE" })]));
    if (data.seller.email)   headerLeftChildren.push(para([txt(data.seller.email,   { size: 16, color: "B0C4DE" })]));
  } else {
    // Individual mode — just a placeholder so cell isn't empty
    headerLeftChildren.push(para([txt("", { size: 20 })]));
  }

  const headerTable = new Table({
    width: { size: W, type: WidthType.DXA },
    columnWidths: [leftW, rightW],
    rows: [new TableRow({ children: [
      cell(headerLeftChildren, { w: leftW, bg: C.primary, margins: { top: 280, bottom: 280, left: 280, right: 200 }, borders: nb() }),
      cell([
        new Table({
          width: { size: rightW - 480, type: WidthType.DXA },
          columnWidths: [
            Math.floor((rightW - 480) * 0.58),
            Math.ceil((rightW - 480) * 0.42),
          ],
          rows: [new TableRow({ children: [
            cell([para([txt("INVOICE", { size: 32, bold: true, color: C.headerText })])],
              { w: Math.floor((rightW - 480) * 0.58), bg: C.accent, margins: { top: 0, bottom: 0, left: 0, right: 40 }, borders: nb() }),
            cell([para([txt("فاتورة", { size: 32, bold: true, color: C.headerText, ar: true })], { align: AlignmentType.RIGHT, rtl: true })],
              { w: Math.ceil((rightW - 480) * 0.42), bg: C.accent, margins: { top: 0, bottom: 0, left: 40, right: 0 }, borders: nb() }),
          ]})],
        }),
        gap(0.3),
        para([txt("#" + data.invoice_number, { size: 20, bold: true, color: "C7D9FF" })], { align: AlignmentType.RIGHT }),
      ], { w: rightW, bg: C.accent, margins: { top: 280, bottom: 280, left: 200, right: 280 }, borders: nb() }),
    ]})],
  });
  children.push(headerTable, gap(0.5));

  // ── META STRIP (Date / Due / Currency) ───────────────────────────────────
  const metaCols  = data.due_date ? 3 : 2;
  const metaCW    = data.due_date
    ? [Math.floor(W/3), Math.floor(W/3), W - 2*Math.floor(W/3)]
    : [Math.floor(W/2), W - Math.floor(W/2)];
  const metaCells = [
    cell([
      para([txt("Invoice Date  /  تاريخ الفاتورة", { size: 15, color: C.textMid })]),
      para([txt(data.date, { size: 20, bold: true })]),
    ], { w: metaCW[0], bg: C.accentLight, margins: { top: 120, bottom: 120, left: 180, right: 120 },
      borders: { top: b1(C.accent), bottom: b1(C.accent), left: none(), right: none() } }),
  ];
  if (data.due_date) {
    metaCells.push(cell([
      para([txt("Due Date  /  تاريخ الاستحقاق", { size: 15, color: C.textMid })]),
      para([txt(data.due_date, { size: 20, bold: true })]),
    ], { w: metaCW[1], bg: C.accentLight, margins: { top: 120, bottom: 120, left: 180, right: 120 },
      borders: { top: b1(C.accent), bottom: b1(C.accent), left: none(), right: none() } }));
  }
  metaCells.push(cell([
    para([txt("Currency  /  العملة", { size: 15, color: C.textMid })]),
    para([txt(cur + (data.vat_pct > 0 ? `  |  VAT ${data.vat_pct}%` : ""), { size: 20, bold: true })]),
  ], { w: metaCW[metaCols-1], bg: C.accentLight, margins: { top: 120, bottom: 120, left: 180, right: 180 },
    borders: { top: b1(C.accent), bottom: b1(C.accent), left: none(), right: none() } }));

  children.push(new Table({ width: { size: W, type: WidthType.DXA }, columnWidths: metaCW, rows: [new TableRow({ children: metaCells })] }));
  children.push(gap(0.8));

  // ── FROM / BILL TO ────────────────────────────────────────────────────────
  const half = Math.floor(W / 2);
  const fromChildren = [];
  if (hasComp) {
    fromChildren.push(
      para([txt("FROM  /  من", { size: 15, bold: true, color: C.accent })]),
      gap(0.2),
      para([txt(data.seller.name, { size: 20, bold: true })]),
    );
    if (data.seller.address) fromChildren.push(para([txt(data.seller.address, { size: 18, color: C.textMid })]));
    if (data.seller.phone)   fromChildren.push(para([txt(data.seller.phone,   { size: 18, color: C.textMid })]));
    if (data.seller.email)   fromChildren.push(para([txt(data.seller.email,   { size: 18, color: C.textMid })]));
  }

  const billToChildren = [
    para([txt("BILL TO  /  إلى", { size: 15, bold: true, color: C.accent })]),
    gap(0.2),
    para([txt(data.buyer.name || "—", { size: 20, bold: true })]),
  ];
  if (data.buyer.address) billToChildren.push(para([txt(data.buyer.address, { size: 18, color: C.textMid })]));
  if (data.buyer.phone)   billToChildren.push(para([txt(data.buyer.phone,   { size: 18, color: C.textMid })]));
  if (data.buyer.email)   billToChildren.push(para([txt(data.buyer.email,   { size: 18, color: C.textMid })]));

  if (hasComp) {
    const fromToTable = new Table({
      width: { size: W, type: WidthType.DXA },
      columnWidths: [half, W - half],
      rows: [new TableRow({ children: [
        cell(fromChildren,   { w: half,    margins: { top: 100, bottom: 100, left: 0,   right: 200 }, borders: nb() }),
        cell(billToChildren, { w: W-half,  margins: { top: 100, bottom: 100, left: 200, right: 0   },
          borders: { top: none(), bottom: none(), right: none(), left: b1(C.border) } }),
      ]})],
    });
    children.push(fromToTable);
  } else {
    // No company — just Bill To, full width
    const billTable = new Table({
      width: { size: W, type: WidthType.DXA },
      columnWidths: [W],
      rows: [new TableRow({ children: [
        cell(billToChildren, { w: W, margins: { top: 100, bottom: 100, left: 0, right: 0 }, borders: nb() }),
      ]})],
    });
    children.push(billTable);
  }
  children.push(gap(0.8));

  // ── ITEMS TABLE ────────────────────────────────────────────────────────────
  const thC = (label, w, align = AlignmentType.LEFT) => cell([
    para([txt(label, { size: 17, bold: true, color: C.headerText })], { align }),
  ], { w, bg: C.primary, margins: { top: 110, bottom: 110, left: 140, right: 140 }, borders: nb() });

  const headerCells = [
    thC("#",                        cW[0]),
    thC("Description / الوصف",       cW[1]),
    thC("Qty / الكمية",              cW[2], AlignmentType.RIGHT),
    thC("Unit Price / سعر الوحدة",   cW[3], AlignmentType.RIGHT),
  ];
  if (showDiscount) headerCells.push(thC("Disc% / خصم", cW[4], AlignmentType.RIGHT));
  headerCells.push(thC("Total / المجموع", cW[showDiscount ? 5 : 4], AlignmentType.RIGHT));
  const thead = new TableRow({ tableHeader: true, children: headerCells });

  const itemRows = rows.map((it, i) => {
    const bg = i % 2 === 0 ? "FFFFFF" : C.rowAlt;
    const rowB = { top: none(), bottom: b1(C.border), left: none(), right: none() };
    const dC = (t, w, align = AlignmentType.LEFT) => cell([
      para([txt(String(t), { size: 18 })], { align }),
    ], { w, bg, margins: { top: 90, bottom: 90, left: 140, right: 140 }, borders: rowB });
    const rowCells = [
      dC(i+1,               cW[0]),
      dC(it.description,    cW[1]),
      dC(it.qty,            cW[2], AlignmentType.RIGHT),
      dC(fmt(it.unit_price),cW[3], AlignmentType.RIGHT),
    ];
    if (showDiscount) rowCells.push(dC(it.discount_pct > 0 ? it.discount_pct + "%" : "—", cW[4], AlignmentType.RIGHT));
    rowCells.push(dC(fmt(it.net), cW[showDiscount ? 5 : 4], AlignmentType.RIGHT));
    return new TableRow({ children: rowCells });
  });

  children.push(new Table({ width: { size: W, type: WidthType.DXA }, columnWidths: cW, rows: [thead, ...itemRows] }));
  children.push(gap(0.5));

  // ── TOTALS ─────────────────────────────────────────────────────────────────
  const TW    = Math.floor(W * 0.42);
  const LW    = Math.floor(TW * 0.54);
  const VW    = TW - LW;
  const SPACE = W - TW;

  const tRow = (label, value, o = {}) => new TableRow({ children: [
    cell([para([txt("")])], { w: SPACE, borders: nb() }),
    cell([para([txt(label, { size: o.grand ? 19 : 17, bold: o.grand, color: o.grand ? C.headerText : C.textMid })], { align: AlignmentType.LEFT })],
      { w: LW, bg: o.bg || "FFFFFF", margins: { top: 80, bottom: 80, left: 140, right: 80 },
        borders: o.top ? { top: b1(C.border), bottom: none(), left: none(), right: none() } : nb() }),
    cell([para([txt(cur + " " + value, { size: o.grand ? 19 : 17, bold: o.grand, color: o.grand ? C.headerText : C.textDark })], { align: AlignmentType.RIGHT })],
      { w: VW, bg: o.bg || "FFFFFF", margins: { top: 80, bottom: 80, left: 80, right: 140 },
        borders: o.top ? { top: b1(C.border), bottom: none(), left: none(), right: none() } : nb() }),
  ]});

  const totRows = [tRow("Subtotal  /  مجموع فرعي", fmt(subtotal))];
  if (showDiscount) {
    totRows.push(tRow("Line discount  /  خصم البنود", "- " + fmt(totalDisc)));
    totRows.push(tRow("Net Subtotal  /  صافي", fmt(netSub), { top: true }));
  }
  if (invoiceDiscount.enabled && invoiceDiscount.amount > 0) {
    const pctSuffix = invoiceDiscount.type === "pct" ? ` (${invoiceDiscount.value}%)` : "";
    totRows.push(tRow(`Invoice discount${pctSuffix}  /  خصم الفاتورة`, "- " + fmt(invoiceDiscount.amount)));
  }
  if (data.vat_pct > 0) {
    totRows.push(tRow(`VAT (${data.vat_pct}%)  /  ضريبة`, fmt(vatAmt)));
  }
  totRows.push(tRow("GRAND TOTAL  /  الإجمالي الكلي", fmt(grand), { grand: true, bg: C.primary, top: true }));

  children.push(new Table({ width: { size: W, type: WidthType.DXA }, columnWidths: [SPACE, LW, VW], rows: totRows }));
  children.push(gap(0.5));

  // ── WRITTEN AMOUNT (English + Arabic) ─────────────────────────────────────
  children.push(new Table({
    width: { size: W, type: WidthType.DXA }, columnWidths: [W],
    rows: [new TableRow({ children: [
      cell([
        // English line
        para([
          txt("Amount in words:  ", { size: 16, bold: true, color: C.textMid }),
          txt(words.en, { size: 16, italic: true, color: C.primary }),
        ]),
        // Arabic line - true RTL logical order
        para([
          txt("المبلغ كتابةً: " + words.ar, { size: 16, italic: true, color: C.primary, ar: true }),
        ], { align: AlignmentType.RIGHT, rtl: true }),
      ], { w: W, bg: C.accentLight, margins: { top: 100, bottom: 100, left: 200, right: 200 },
        borders: { top: b1(C.accent), bottom: b1(C.accent), left: b1(C.accent), right: b1(C.accent) } }),
    ]})]
  }));
  children.push(gap(0.8));

  // ── NOTES ──────────────────────────────────────────────────────────────────
  const disclaimerLines = [];
  if (data.individual_disclaimer) {
    if (data.language === "en" || data.language === "bi") {
      disclaimerLines.push("Invoice issued by an independent individual for services rendered.");
    }
    if (data.language === "ar" || data.language === "bi") {
      disclaimerLines.push("فاتورة صادرة عن فرد مستقل مقابل خدمات مقدمة.");
    }
  }
  const notes = [data.notes || "", ...disclaimerLines].filter(Boolean).join("\n");
  const noteLines = notes.split("\n").filter(l => l.trim());
  const thankYouAr = "شكراً لتعاملكم معنا";
  const thankYouEn = "Thank you for your business!";

  const noteChildren = [
    para([txt("Notes  /  ملاحظات", { size: 15, bold: true, color: C.textMid })]),
    gap(0.2),
    ...noteLines.map(l => {
      const ar = hasArabic(l);
      return para([txt(l, { size: 17, color: C.textMid, ar })], { align: AlignmentType.LEFT, rtl: ar });
    }),
    ...(noteLines.length > 0 ? [gap(0.3)] : []),
    // Thank you — always shown, stacked English over Arabic
    para([txt(thankYouEn, { size: 18, bold: true, color: C.accent })], { align: AlignmentType.CENTER }),
    para([txt(thankYouAr, { size: 18, bold: true, color: C.accent, ar: true })], { align: AlignmentType.CENTER, rtl: true }),
  ];

  children.push(new Table({
    width: { size: W, type: WidthType.DXA }, columnWidths: [W],
    rows: [new TableRow({ children: [
      cell(noteChildren, { w: W, bg: "FAFAFA", margins: { top: 140, bottom: 140, left: 200, right: 200 },
        borders: { top: b1(C.border), bottom: b1(C.border), left: none(), right: none() } }),
    ]})]
  }));

  // ── FOOTER ─────────────────────────────────────────────────────────────────
  const footerContent = hasComp
    ? (data.seller.name + (data.seller.email ? "  |  " + data.seller.email : ""))
    : (data.seller && data.seller.email ? data.seller.email : "");

  const footer = new Footer({ children: [
    new Paragraph({
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.accent, space: 6 } },
      spacing: { before: 80, after: 0 },
      tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
      children: [
        new TextRun({ text: footerContent, font: "Arial", size: 16, color: C.textLight }),
        new TextRun({ text: "\tPage ", font: "Arial", size: 16, color: C.textLight }),
        new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 16, color: C.textLight }),
        new TextRun({ text: " / ", font: "Arial", size: 16, color: C.textLight }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], font: "Arial", size: 16, color: C.textLight }),
      ],
    }),
  ]});

  // ── ASSEMBLE ───────────────────────────────────────────────────────────────
  const doc = new Document({
    styles: { default: { document: { run: { font: "Arial", size: 20, color: C.textDark } } } },
    sections: [{
      properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: MARG } },
      footers: { default: footer },
      children,
    }],
  });

  const outDir  = path.join(__dirname, "data", "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `invoice_${data.invoice_number}.docx`);
  const buf     = await Packer.toBuffer(doc);
  fs.writeFileSync(outFile, buf);
  console.log(outFile);
}
