#!/bin/bash
# Double-click this file in Finder to start Moneta and open it in your browser.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Moneta needs Node.js 22.13 or newer. Install it from https://nodejs.org and try again."
  read -r -p "Press Enter to close…"
  exit 1
fi

if [ ! -d node_modules/chart.js ]; then
  echo "First run: installing the chart library…"
  npm install --no-audit --no-fund || { read -r -p "Install failed. Press Enter to close…"; exit 1; }
fi

PORT="${PORT:-4747}"
if curl -s -o /dev/null "http://127.0.0.1:${PORT}/api/bootstrap"; then
  echo "Moneta is already running, opening it…"
  open "http://localhost:${PORT}"
  exit 0
fi

(sleep 1.5 && open "http://localhost:${PORT}") &
PORT="$PORT" npm start
