# Bilingual Invoice Maker & PDF Engine

> Production-grade, bilingual (English & Arabic RTL) invoice generation engine and financial document manager with embedded font rendering, multi-template PDF exports, and Supabase database synchronization.

---

## Overview

A full-featured billing and invoice management platform engineered to solve the complex typographical and layout challenges of **bilingual English/Arabic RTL invoicing**. Features pixel-perfect PDF rendering with zero serverless font-drop bugs, multi-company profiles, lifecycle state tracking (Draft, Issued, Paid, Voided, Superseded), and relational database persistence.

`
┌────────────────────────────────────────────────────────┐
│                   Web Invoicing Client                 │
│         (Vanilla JS / CSS SPA + Offline Caching)       │
└──────────────────────────┬─────────────────────────────┘
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
┌─────────────────────────┐ ┌─────────────────────────────┐
│  Serverless PDF Engine  │ │     Flask Local Server      │
│  (@sparticuz/chromium   │ │    (Python 3.10+ Backend)   │
│   + Puppeteer Core)     │ └──────────────┬──────────────┘
└────────────┬────────────┘                │
             │                             │
             └─────────────┬───────────────┘
                           ▼
             ┌───────────────────────────┐
             │   Supabase (PostgreSQL)   │
             │   Multi-Tenant Invoices,  │
             │   Companies, & Audit RLS  │
             └───────────────────────────┘
`

---

## Key Features

### 🌍 First-Class Bilingual & Arabic RTL Typography
- **Self-Contained Embedded Fonts**: Bypasses serverless Chromium font isolation issues by bundling and base64-embedding Noto Naskh Arabic and Amiri directly into @font-face CSS.
- **Bi-Directional Layouts**: Instant toggling between English (LTR) and Arabic (RTL) with appropriate text alignments, tabular numbers, and currency symbol positioning.

### 📄 Multiple Designer PDF Templates
- **Meridian**: Clean corporate layout tailored for enterprise contracts and operations.
- **Aurora v2**: Modern gradient accent styling designed for modern digital agencies and consultancies.
- **Print & Audit Ready**: Conforms to commercial invoice standards and regional tax requirements (e.g. VAT invoice readiness).

### 💼 Complete Invoice Lifecycle & Audit Trail
- **Draft & Version Control**: Auto-saves drafts locally and synchronizes to PostgreSQL.
- **Immutability & Reversals**: Full support for voiding invoices, drafting revisions, and linking superseded audit records without deleting transaction history.
- **Company Profiles**: Switch seamlessly between individual freelance billing and multiple legal company entities.

---

## Tech Stack

- **Frontend**: Vanilla JavaScript (ES modules), CSS3 custom properties, HTML5 canvas/print media queries.
- **PDF Generation**: Node.js, Puppeteer Core, @sparticuz/chromium, custom HTML-to-PDF rendering pipelines.
- **Server & API**:
  - Node.js serverless functions (Vercel /api/generate-pdf.js).
  - Python / Flask alternative server (server.py) with WeasyPrint / Playwright support.
- **Database**: Supabase Managed PostgreSQL (with versioned schema migrations).

---

## Getting Started

### 1. Prerequisites
- **Node.js** (v18+)
- **Python** (v3.10+, optional for Python server runtime)

### 2. Installation

`ash
# Clone the repository
git clone https://github.com/AMR0KF/invoice-app.git
cd invoice-app

# Install Node dependencies
npm install
`

### 3. Running Locally

**Using the Node.js development server:**
`ash
npm run dev
# or
node serve.js
`
Open http://localhost:3000 in your browser.

**Using the Python development server (optional):**
`ash
python -m venv .venv
source .venv/bin/activate  # Or on Windows: .venv\Scripts\activate
pip install -r requirements.txt
python server.py
`

### 4. Supabase Database Configuration (Optional)
To persist invoices and company profiles to Supabase:
1. Copy data/supabase_config.example.json to data/supabase_config.json.
2. Populate your SUPABASE_URL and SUPABASE_ANON_KEY.
3. Apply the SQL migrations located in supabase/migrations/ in order.

---

## Project Structure

`
invoice-app/
├── api/                    # Vercel serverless function entry points
│   └── generate-pdf.js     # Headless Chromium PDF generation endpoint
├── fonts/                  # Embedded Arabic & Latin typography
│   ├── Amiri-Bold.ttf
│   ├── NotoNaskhArabic-Bold.ttf
│   └── NotoNaskhArabic-Regular.ttf
├── supabase/               # Relational database schema and migrations
│   ├── migrations/         # Versioned SQL migrations (invoices, companies, RLS)
│   └── schema.sql          # Base PostgreSQL DDL
├── app.js                  # Core reactive client logic & state management
├── app.css                 # Responsive design system and RTL stylings
├── index.html              # Main application GUI & invoice editor
├── template_meridian.html  # Meridian PDF template
├── generate_pdf.js         # Local Node.js PDF generation module
├── server.py               # Alternative Python/Flask API server
└── vercel.json             # Vercel serverless configuration
`

---

## License
MIT License.
