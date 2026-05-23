#!/bin/bash
echo ""
echo "  ╔══════════════════════════════════╗"
echo "  ║  Invoice Maker / صانع الفواتير   ║"
echo "  ╚══════════════════════════════════╝"
echo ""

# Check Python
if ! command -v python3 &>/dev/null; then
  echo "  ERROR: Python 3 not found. Install from python.org"
  exit 1
fi

# Check Node
if ! command -v node &>/dev/null; then
  echo "  ERROR: Node.js not found. Install from nodejs.org"
  exit 1
fi

# Check docx npm package
if ! node -e "require('docx')" &>/dev/null; then
  echo "  Installing docx npm package..."
  npm install -g docx
fi

if ! node -e "require('puppeteer')" &>/dev/null; then
  echo "  Installing puppeteer..."
  export PUPPETEER_SKIP_DOWNLOAD=true
  npm install puppeteer
fi

# Install Python deps
if ! python3 -c "import flask" &>/dev/null; then
  echo "  Installing Flask..."
  pip3 install flask flask-cors
fi

echo "  Starting at http://localhost:5050"
echo "  Browser will open automatically."
echo "  Press Ctrl+C to stop."
echo ""
python3 server.py
