#!/usr/bin/env python3
"""
server.py — Lightweight Flask backend for Invoice Maker
Serves the HTML UI and handles:
  GET  /api/companies           → list companies
  POST /api/companies           → save company
  DELETE /api/companies/<id>    → remove company
  GET  /api/customers           → list customers
  POST /api/customers           → save customer
  DELETE /api/customers/<id>    → remove customer
  POST /api/generate            → generate .docx, return filename
  GET  /api/download/<filename> → download generated invoice
"""

import json
import os
import subprocess
import sys
import uuid
import webbrowser
from html import escape
from pathlib import Path
from threading import Timer

# ── Flask import with helpful error ──────────────────────────────────────────
try:
    from flask import Flask, jsonify, request, send_file, send_from_directory
    from flask_cors import CORS
except ImportError:
    print("\n❌  Missing dependencies. Run:\n")
    print("    pip install flask flask-cors\n")
    sys.exit(1)

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE   = Path(__file__).parent
STATIC_DATA = BASE / "data"
DATA   = Path(os.getenv("INVOICE_DATA_DIR") or (Path(os.getenv("TMPDIR", "/tmp")) / "invoice-maker" if os.getenv("VERCEL") else STATIC_DATA))
OUT    = DATA / "output"
PRINTS = DATA / "print_jobs"
DATA.mkdir(exist_ok=True)
OUT.mkdir(exist_ok=True)
PRINTS.mkdir(exist_ok=True)

COMPANIES_FILE = DATA / "companies.json"
CUSTOMERS_FILE = DATA / "customers.json"
SETTINGS_FILE = DATA / "settings.json"
SUPABASE_CONFIG_FILE = STATIC_DATA / "supabase_config.json"

# ── Helpers ───────────────────────────────────────────────────────────────────
def load_json(path):
    if path.exists():
        with open(path, encoding="utf-8-sig") as f:
            return repair_mojibake(json.load(f))
    return []

def repair_mojibake(value):
    if isinstance(value, list):
        return [repair_mojibake(item) for item in value]
    if isinstance(value, dict):
        return {key: repair_mojibake(item) for key, item in value.items()}
    if not isinstance(value, str):
        return value
    try:
        fixed = value.encode("cp1252").decode("utf-8")
    except UnicodeError:
        return value
    return fixed if any("\u0600" <= ch <= "\u06ff" for ch in fixed) else value

def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def next_invoice_number(value):
    value = (value or "INV-000").strip()
    prefix = value.rstrip("0123456789")
    digits = value[len(prefix):]
    if not digits:
        return "INV-001"
    return f"{prefix}{int(digits) + 1:0{len(digits)}d}"

def get_settings():
    data = load_json(SETTINGS_FILE)
    return data if isinstance(data, dict) else {}

def save_settings(settings):
    save_json(SETTINGS_FILE, settings)

def get_supabase_config():
    file_config = {}
    if SUPABASE_CONFIG_FILE.exists():
        loaded = load_json(SUPABASE_CONFIG_FILE)
        if isinstance(loaded, dict):
            file_config = loaded
    url = os.getenv("SUPABASE_URL") or file_config.get("url") or ""
    anon_key = os.getenv("SUPABASE_ANON_KEY") or file_config.get("anon_key") or ""
    return {"url": url.strip(), "anon_key": anon_key.strip()}

def money(value):
    return f"{float(value or 0):,.2f}"

def currency_symbol(value):
    return {"USD": "$", "LBP": "ل.ل"}.get(str(value or "").upper(), str(value or ""))

def money_with_symbol(value, currency):
    symbol = currency_symbol(currency)
    amount = money(value)
    return f"{symbol} {amount}" if symbol else amount

def calc_invoice(data):
    include_discount = bool(data.get("include_discount"))
    subtotal = 0
    total_discount = 0
    rows = []
    for item in data.get("items", []):
        qty = float(item.get("qty") or 0)
        unit = float(item.get("unit_price") or 0)
        discount_pct = float(item.get("discount_pct") or 0) if include_discount else 0
        gross = qty * unit
        discount = gross * discount_pct / 100
        net = gross - discount
        subtotal += gross
        total_discount += discount
        rows.append({**item, "qty": qty, "unit_price": unit, "discount_pct": discount_pct, "net": net})

    net_subtotal = subtotal - total_discount

    # Invoice-wide discount: applied after line discounts, before VAT.
    inv_disc_payload = data.get("invoice_discount") or {}
    inv_disc_enabled = bool(inv_disc_payload.get("enabled"))
    inv_disc_type = "fixed" if inv_disc_payload.get("type") == "fixed" else "pct"
    inv_disc_value = max(0.0, float(inv_disc_payload.get("value") or 0))
    if inv_disc_enabled:
        inv_disc_amount = inv_disc_value if inv_disc_type == "fixed" else net_subtotal * inv_disc_value / 100
        if inv_disc_amount > net_subtotal:
            inv_disc_amount = net_subtotal
    else:
        inv_disc_amount = 0.0

    taxable_base = net_subtotal - inv_disc_amount
    vat_pct = float(data.get("vat_pct") or 0)
    vat = taxable_base * vat_pct / 100
    return {
        "rows": rows,
        "subtotal": subtotal,
        "discount": total_discount,
        "invoice_discount_enabled": inv_disc_enabled,
        "invoice_discount_type": inv_disc_type,
        "invoice_discount_value": inv_disc_value,
        "invoice_discount": inv_disc_amount,
        "vat_pct": vat_pct,
        "vat": vat,
        "grand": taxable_base + vat,
        "show_discount": include_discount and total_discount > 0,
        "show_invoice_discount": inv_disc_enabled and inv_disc_amount > 0,
    }

def e(value):
    return escape(str(value or ""))

def has_arabic(value):
    return any("\u0600" <= ch <= "\u06ff" for ch in str(value or ""))

def render_party(title, party):
    lines = [f"<h3>{title}</h3>", f"<strong dir=\"auto\">{e(party.get('name'))}</strong>"]
    for key in ("address", "phone", "email"):
        if party.get(key):
            lines.append(f"<span dir=\"auto\">{e(party.get(key))}</span>")
    return "\n".join(lines)

def bi_label(lang, en, ar):
    if lang == "ar":
        return ar
    if lang == "bi":
        return f"{en} / {ar}"
    return en

def invoice_notes(data, lang="bi"):
    notes = (data.get("notes") or "").strip() or "Payment due within 1 week."
    if data.get("individual_disclaimer"):
        lines = []
        if lang in {"en", "bi"}:
            lines.append("Invoice issued by an independent individual for services rendered.")
        if lang in {"ar", "bi"}:
            lines.append("فاتورة صادرة عن فرد مستقل مقابل خدمات مقدمة.")
        notes += "\n" + "\n".join(lines)
    return notes

def render_print_invoice(data):
    template = data.get("template") if data.get("template") in {"aurora", "meridian", "obsidian", "classic"} else "aurora"
    lang = data.get("language") if data.get("language") in {"en", "ar", "bi"} else "bi"
    totals = calc_invoice(data)
    cur = e(data.get("currency") or "USD")
    cur_symbol = "$" if (data.get("currency") or "USD") == "USD" else cur
    invoice_no = e(data.get("invoice_number") or "INV-001")
    seller = data.get("seller") or {}
    buyer = data.get("buyer") or {}
    rows = []
    for idx, item in enumerate(totals["rows"], 1):
        discount_cell = f"<td>{money(item['discount_pct']).rstrip('0').rstrip('.')}%</td>" if totals["show_discount"] else ""
        rows.append(f"""
          <tr>
            <td>{idx:02d}</td>
            <td dir="auto">{e(item.get('description'))}</td>
            <td>{money(item['qty']).rstrip('0').rstrip('.')}</td>
            <td><span class="money-cell"><span class="money-symbol">{cur_symbol}</span><span>{money(item['unit_price'])}</span></span></td>
            {discount_cell}
            <td><span class="money-cell"><span class="money-symbol">{cur_symbol}</span><span>{money(item['net'])}</span></span></td>
          </tr>""")
    discount_head = ""
    discount_total = ""
    vat_total = f"<div><span>VAT ({money(totals['vat_pct']).rstrip('0').rstrip('.')}%)</span><strong>{e(money_with_symbol(totals['vat'], cur))}</strong></div>" if totals["vat_pct"] > 0 else ""
    date = e(data.get("date"))
    due = data.get("due_date")
    due_card = f"""<section><small>DUE DATE</small><strong>{e(due)}</strong></section>""" if due else ""
    if due:
        due_card = f"""<section><small>{bi_label(lang, "DUE DATE", "تاريخ الاستحقاق")}</small><strong>{e(due)}</strong></section>"""
    meta_block = f"""<div class="meta">{due_card}</div>""" if due_card else ""
    note_lines = []
    for line in invoice_notes(data, lang).splitlines():
        is_ar = has_arabic(line)
        cls = "note-line ar-note" if is_ar else "note-line"
        note_lines.append(f"""<span class="{cls}" dir="{"rtl" if is_ar else "auto"}">{e(line)}</span>""")
    notes_html = "".join(note_lines)
    notes_title = bi_label(lang, "NOTES", "ملاحظات")
    invoice_title = bi_label(lang, "Invoice", "فاتورة")
    from_label = bi_label(lang, "FROM", "من")
    bill_to_label = bi_label(lang, "BILL TO", "إلى")
    th_desc = bi_label(lang, "DESCRIPTION", "الوصف")
    th_qty = bi_label(lang, "QTY", "الكمية")
    th_unit = bi_label(lang, "UNIT PRICE", "سعر الوحدة")
    th_amount = bi_label(lang, "AMOUNT", "المجموع")
    th_disc = bi_label(lang, "DISC.", "خصم")
    subtotal_label = bi_label(lang, "Subtotal", "المجموع الفرعي")
    discount_label = bi_label(lang, "Line discount", "خصم البنود")
    invoice_discount_label = bi_label(lang, "Invoice discount", "خصم الفاتورة")
    total_label = bi_label(lang, "Total", "الإجمالي")
    thank_en = "Thank you for your business!" if lang in {"en", "bi"} else ""
    thank_ar = "شكراً لتعاملكم معنا" if lang in {"ar", "bi"} else ""
    discount_head = f"<th>{th_disc}</th>" if totals["show_discount"] else ""
    discount_total = f"<div><span>{discount_label}</span><strong>- {e(money_with_symbol(totals['discount'], cur))}</strong></div>" if totals["show_discount"] else ""
    if totals["show_invoice_discount"]:
        inv_lbl = invoice_discount_label
        if totals["invoice_discount_type"] == "pct":
            pct_str = money(totals["invoice_discount_value"]).rstrip("0").rstrip(".")
            inv_lbl = f"{invoice_discount_label} ({pct_str}%)"
        invoice_discount_total = f"<div><span>{inv_lbl}</span><strong>- {e(money_with_symbol(totals['invoice_discount'], cur))}</strong></div>"
    else:
        invoice_discount_total = ""
    seller_name = e(seller.get("name") or "Company")
    seller_name_dir = "rtl" if has_arabic(seller.get("name")) else "auto"
    seller_name_class = "company-title arabic-title" if has_arabic(seller.get("name")) else "company-title"

    return f"""<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<title>Invoice {invoice_no}</title>
<style>
@page {{ size: A4; margin: 0; }}
* {{ box-sizing: border-box; }}
body {{
  --paper: #ffffff;
  --ink: #101828;
  --muted: #667085;
  --brand: #756bff;
  --brand-strong: #5f55ee;
  --line: #d9ddff;
  --soft: #fbfaff;
  --hero-a: #e9edff;
  --hero-b: #fde8f5;
  margin: 0;
  background: #eef0f4;
  color: var(--ink);
  font-family: Arial, sans-serif;
}}
body.meridian {{
  --paper: #fffdf8;
  --ink: #111827;
  --muted: #667085;
  --brand: #b88a3d;
  --brand-strong: #8d6729;
  --line: #e8dcc4;
  --soft: #fff8ea;
}}
body.obsidian {{
  --paper: #ffffff;
  --ink: #111827;
  --muted: #667085;
  --brand: #334155;
  --brand-strong: #111827;
  --line: #d7dde8;
  --soft: #f7f9fc;
}}
[dir="auto"], [dir="rtl"], .arabic {{ unicode-bidi: plaintext; }}
[dir="rtl"], .arabic {{ direction: rtl; font-family: "Arabic Typesetting", "Traditional Arabic", Tahoma, Arial, sans-serif; }}
.page {{ width: 210mm; min-height: 297mm; margin: 0 auto; background: var(--paper); padding: 18mm; position: relative; overflow: hidden; }}
body.aurora .page {{ padding-top: 0; }}
body.aurora .hero {{ position: relative; z-index: 1; height: 38mm; margin: 0 -18mm 8mm; padding: 9mm 18mm 0; background: linear-gradient(105deg, #e2e8ff 0%, #eee9ff 50%, #fde8f6 100%); display: flex; justify-content: space-between; align-items: flex-start; }}
body.aurora .hero:after {{
  content: "";
  position: absolute;
  left: 18mm;
  right: 18mm;
  bottom: 3mm;
  height: 3mm;
  background: #ffffff;
  opacity: .96;
  clip-path: polygon(0 62%, 16% 55%, 32% 47%, 48% 43%, 64% 49%, 82% 57%, 100% 51%, 100% 100%, 0 100%);
}}
body.aurora .meta,
body.aurora .parties,
body.aurora table,
body.aurora .bottom,
body.aurora .thanks-footer,
body.aurora footer {{ position: relative; z-index: 2; }}
body.meridian .page {{ border-left: 2mm solid var(--brand); padding: 18mm 18mm 16mm 18mm; }}
body.obsidian .page {{ border-left: 18mm solid #111827; }}
.brand {{ display: flex; gap: 4mm; align-items: center; min-height: 12mm; }}
.company-title {{ margin: 0; font-size: 14pt; }}
.arabic-title {{ font-family: "Arabic Typesetting", "Traditional Arabic", Tahoma, Arial, sans-serif; font-size: 28pt; line-height: 1; font-weight: 700; }}
.brand p, .invoice-id p {{ margin: 1mm 0 0; color: var(--muted); font-size: 8pt; }}
.invoice-id {{ text-align: right; }}
.invoice-id h2 {{ margin: 0; color: var(--brand-strong); font-size: 22pt; }}
body.aurora .invoice-id h2 {{ color: #1e1b4b; }}
body.aurora .company-title {{ font-size: 14pt; }}
body.aurora .arabic-title {{ font-size: 28pt; }}
body.aurora .invoice-id h2 {{ font-size: 18pt; }}
body.aurora .invoice-id p {{ color: #635bff; font-size: 7.5pt; }}
.meridian-head {{ display: none; }}
body.meridian .meridian-head, body.obsidian .meridian-head, body.classic .meridian-head {{ display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--line); padding-bottom: 10mm; margin-bottom: 8mm; }}
body.meridian .meridian-head {{ border-bottom: 0; }}
body.meridian .meridian-head .invoice-id p:first-child {{ color: var(--brand); font-size: 8pt; letter-spacing: .1em; font-weight: 800; }}
body.meridian .hero, body.obsidian .hero, body.classic .hero {{ display: none; }}
.meta {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(42mm, 1fr)); gap: 3mm; margin: 8mm 0 7mm; }}
.meta section {{ border: 1px solid var(--line); border-radius: 2mm; padding: 4mm; background: color-mix(in srgb, var(--soft) 72%, white); }}
body.meridian .meta {{ border-bottom: 1px solid var(--line); padding-bottom: 7mm; }}
body.meridian .meta section {{ background: transparent; border: 0; padding: 0; }}
small, .section-title {{ color: var(--brand); font-size: 7.5pt; font-weight: 800; letter-spacing: .08em; }}
.meta strong {{ display: block; margin-top: 2mm; font-size: 10pt; }}
.parties {{ display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; margin-bottom: 8mm; }}
.party {{ border: 1px solid #edf0f4; border-radius: 2mm; padding: 5mm; min-height: 24mm; }}
body.aurora .parties {{ gap: 4mm; margin-top: 0; margin-bottom: 8mm; }}
body.aurora .party {{
  min-height: 25mm;
  border: 1px solid #dfe4ff;
  border-radius: 5mm;
  padding: 4.5mm 5mm;
  background: linear-gradient(180deg, #ffffff 0%, #fbfbff 100%);
  box-shadow: 0 4mm 10mm rgba(99, 91, 255, .08);
}}
body.aurora .party h3 {{ color: #635bff; font-size: 7.2pt; margin-bottom: 2.2mm; }}
body.aurora .party strong {{ display: block; color: #111827; font-size: 11pt; line-height: 1.25; margin-bottom: 1.5mm; }}
body.aurora .party span {{ color: #475467; font-size: 8pt; line-height: 1.45; }}
body.meridian .parties {{ border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 6mm 0; margin-bottom: 9mm; }}
body.meridian .party {{ border: 0; border-radius: 0; padding: 0; min-height: 18mm; }}
.party h3 {{ margin: 0 0 2mm; color: var(--brand); font-size: 7.5pt; letter-spacing: .08em; }}
.party strong {{ display: block; color: var(--ink); }}
.party span {{ display: block; color: var(--muted); font-size: 8pt; margin-top: 1mm; }}
table {{ width: 100%; border-collapse: collapse; margin-top: 5mm; }}
th {{ color: var(--brand); font-size: 7.5pt; text-align: right; padding: 3mm 2mm; border-bottom: 1px solid var(--line); }}
th:nth-child(2), td:nth-child(2) {{ text-align: left; }}
td {{ font-size: 8.5pt; text-align: right; padding: 3mm 2mm; border-bottom: 1px solid #edf0f4; }}
.money-cell {{ display: inline-flex; justify-content: flex-end; align-items: baseline; gap: .9mm; min-width: 18mm; font-variant-numeric: tabular-nums; }}
.money-symbol {{ color: var(--ink); }}
tbody tr:nth-child(odd) {{ background: var(--soft); }}
body.meridian td {{ border-bottom-color: #eee4d2; }}
.bottom {{ display: grid; grid-template-columns: 1fr 52mm; gap: 10mm; margin-top: 10mm; align-items: start; }}
.notes {{ color: var(--muted); font-size: 8pt; line-height: 1.6; }}
.note-line {{ display: block; text-align: left; }}
.ar-note {{ direction: rtl; text-align: left; font-family: Arial, "Traditional Arabic", sans-serif; }}
.thanks-footer {{ margin-top: 14mm; text-align: center; color: var(--brand); font-weight: 700; }}
.thanks-footer .thanks-en {{ margin: 0 0 1.5mm; font-size: 11pt; }}
.thanks-footer .thanks-ar {{ margin: 0; direction: rtl; font-family: Arial, "Traditional Arabic", sans-serif; font-size: 10pt; line-height: 1.35; font-weight: 400; }}
.totals div {{ display: flex; justify-content: space-between; font-size: 8.5pt; padding: 2mm 0; }}
.grand {{ margin-top: 2mm; padding: 4mm !important; border-radius: 2mm; background: var(--brand); color: white; align-items: center; }}
body.meridian .grand {{ background: transparent; color: var(--ink); border-top: 1px solid var(--line); border-radius: 0; padding-left: 0 !important; padding-right: 0 !important; }}
body.meridian .grand strong {{ color: var(--ink); }}
.grand strong {{ font-size: 16pt; }}
footer {{ position: absolute; left: 18mm; right: 18mm; bottom: 8mm; color: #c7cbd1; font-size: 7pt; display: flex; justify-content: flex-end; }}
@media print {{ body {{ background: white; }} .page {{ margin: 0; }} .no-print {{ display: none; }} }}
.no-print {{ position: fixed; top: 10px; right: 10px; display: flex; gap: 8px; }}
.no-print button {{ padding: 8px 12px; border: 0; border-radius: 6px; background: #111827; color: white; cursor: pointer; }}
</style>
</head>
<body class="{template}">
<div class="no-print"><button onclick="window.print()">Print / Save PDF</button></div>
<main class="page">
  <header class="hero">
    <div class="brand"><div><h1 class="{seller_name_class}" dir="{seller_name_dir}">{seller_name}</h1><p dir="auto">{e(seller.get("email") or "")}</p></div></div>
    <div class="invoice-id"><h2>{invoice_title}</h2><p>{invoice_no}</p><p>{bi_label(lang, "Issued", "تاريخ الإصدار")}: {date}</p></div>
  </header>
  <header class="meridian-head">
    <div><h1 class="{seller_name_class}" dir="{seller_name_dir}">{seller_name}</h1><p dir="auto">{e(seller.get("address") or "")}</p><p dir="auto">{e(seller.get("email") or "")}</p></div>
    <div class="invoice-id"><p>{invoice_title.upper()}</p><h2>{invoice_no}</h2><p>{bi_label(lang, "Issued", "تاريخ الإصدار")}: {date}</p></div>
  </header>
  {meta_block}
  <div class="parties"><div class="party party-from">{render_party(from_label, seller)}</div><div class="party party-bill">{render_party(bill_to_label, buyer)}</div></div>
  <table><thead><tr><th>#</th><th>{th_desc}</th><th>{th_qty}</th><th>{th_unit}</th>{discount_head}<th>{th_amount}</th></tr></thead><tbody>{"".join(rows)}</tbody></table>
  <section class="bottom">
    <div class="notes"><div class="section-title">{notes_title}</div><p dir="auto">{notes_html}</p></div>
    <div class="totals"><div><span>{subtotal_label}</span><strong>{e(money_with_symbol(totals["subtotal"], cur))}</strong></div>{discount_total}{invoice_discount_total}{vat_total}<div class="grand"><span>{total_label}</span><strong>{e(money_with_symbol(totals["grand"], cur))}</strong></div></div>
  </section>
  <section class="thanks-footer">
    {f'<p class="thanks-en">{thank_en}</p>' if thank_en else ''}
    {f'<p class="thanks-ar">{thank_ar}</p>' if thank_ar else ''}
  </section>
  <footer><span>Page 1 / 1</span></footer>
</main>
<script>setTimeout(() => window.print(), 500);</script>
</body>
</html>"""

# ── App ───────────────────────────────────────────────────────────────────────
app = Flask(__name__, static_folder=str(BASE), static_url_path="")
CORS(app)

@app.route("/")
def index():
    return send_from_directory(str(BASE), "index.html")

@app.route("/app.css")
def serve_app_css():
    return send_from_directory(str(BASE), "app.css")

@app.route("/app.js")
def serve_app_js():
    return send_from_directory(str(BASE), "app.js")

@app.route("/api/invoice-number", methods=["GET"])
def get_invoice_number():
    settings = get_settings()
    current = settings.get("next_invoice_number") or "INV-001"
    settings["next_invoice_number"] = current
    save_settings(settings)
    return jsonify({"invoice_number": current})

@app.route("/api/supabase-config", methods=["GET"])
def supabase_config():
    config = get_supabase_config()
    return jsonify({
        "enabled": bool(config["url"] and config["anon_key"]),
        "url": config["url"],
        "anon_key": config["anon_key"],
    })

# ── Companies ─────────────────────────────────────────────────────────────────
@app.route("/api/companies", methods=["GET"])
def get_companies():
    return jsonify(load_json(COMPANIES_FILE))

@app.route("/api/companies", methods=["POST"])
def save_company():
    companies = load_json(COMPANIES_FILE)
    data = request.json
    # Update if id exists, else add new
    existing = next((c for c in companies if c.get("id") == data.get("id")), None)
    if existing:
        existing.update(data)
    else:
        data["id"] = data.get("id") or str(uuid.uuid4())[:8]
        companies.append(data)
    save_json(COMPANIES_FILE, companies)
    return jsonify({"ok": True, "id": data["id"]})

@app.route("/api/companies/<cid>", methods=["DELETE"])
def delete_company(cid):
    companies = [c for c in load_json(COMPANIES_FILE) if c.get("id") != cid]
    save_json(COMPANIES_FILE, companies)
    return jsonify({"ok": True})

# ── Customers ─────────────────────────────────────────────────────────────────
@app.route("/api/customers", methods=["GET"])
def get_customers():
    return jsonify(load_json(CUSTOMERS_FILE))

@app.route("/api/customers", methods=["POST"])
def save_customer():
    customers = load_json(CUSTOMERS_FILE)
    data = request.json
    existing = next((c for c in customers if c.get("id") == data.get("id")), None)
    if existing:
        existing.update(data)
    else:
        data["id"] = data.get("id") or str(uuid.uuid4())[:8]
        customers.append(data)
    save_json(CUSTOMERS_FILE, customers)
    return jsonify({"ok": True, "id": data["id"]})

@app.route("/api/customers/<cid>", methods=["DELETE"])
def delete_customer(cid):
    customers = [c for c in load_json(CUSTOMERS_FILE) if c.get("id") != cid]
    save_json(CUSTOMERS_FILE, customers)
    return jsonify({"ok": True})

# ── Generate Invoice ──────────────────────────────────────────────────────────
@app.route("/api/generate", methods=["POST"])
def generate():
    return generate_pdf()

# ── Download ──────────────────────────────────────────────────────────────────
@app.route("/api/generate-pdf", methods=["POST"])
def generate_pdf():
    data = request.json or {}
    try:
        settings = get_settings()
        invoice_number = settings.get("next_invoice_number") or data.get("invoice_number") or "INV-001"
        data["invoice_number"] = invoice_number
        result = subprocess.run(
            ["node", str(BASE / "generate_pdf.js")],
            input=json.dumps(data, ensure_ascii=False),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            cwd=str(BASE),
            env={**os.environ, "INVOICE_OUTPUT_DIR": str(OUT)},
        )
        if result.returncode != 0:
            return jsonify({"error": result.stderr or "PDF generation failed"}), 500
        filename = Path(result.stdout.strip()).name
        settings["next_invoice_number"] = next_invoice_number(invoice_number)
        save_settings(settings)
        return jsonify({"ok": True, "filename": filename, "invoice_number": invoice_number, "next_invoice_number": settings["next_invoice_number"]})
    except subprocess.TimeoutExpired:
        return jsonify({"error": "PDF generation timed out. Please try again."}), 504
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/print-preview", methods=["POST"])
def create_print_preview():
    data = request.json
    settings = get_settings()
    invoice_number = settings.get("next_invoice_number") or data.get("invoice_number") or "INV-001"
    data["invoice_number"] = invoice_number
    job_id = str(uuid.uuid4())[:10]
    save_json(PRINTS / f"{job_id}.json", data)
    settings["next_invoice_number"] = next_invoice_number(invoice_number)
    save_settings(settings)
    return jsonify({"ok": True, "url": f"/print/{job_id}", "invoice_number": invoice_number, "next_invoice_number": settings["next_invoice_number"]})

@app.route("/print/<job_id>")
def print_preview(job_id):
    safe = "".join(ch for ch in job_id if ch.isalnum() or ch in "-_")
    path = PRINTS / f"{safe}.json"
    if not path.exists():
        return "Print preview not found", 404
    return render_print_invoice(load_json(path))

@app.route("/api/download/<filename>")
def download(filename):
    safe = Path(filename).name  # prevent path traversal
    return send_from_directory(str(OUT), safe, as_attachment=True)

# ── Launch ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = 5050
    url  = f"http://localhost:{port}"
    print(f"\nInvoice Maker running at {url}")
    print("    Press Ctrl+C to stop.\n")
    Timer(1.2, lambda: webbrowser.open(url)).start()
    app.run(port=port, debug=False)
