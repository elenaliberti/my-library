#!/bin/bash
# ── My Library — setup & launch ──────────────────────────────────────────────
# Run this once from the my-library folder:  bash setup.sh

set -e

echo ""
echo "  📚 My Library — setup"
echo "  ─────────────────────"
echo ""

# Check Node
if ! command -v node &> /dev/null; then
  echo "  ✗ Node.js not found."
  echo "    Install it from https://nodejs.org (LTS version) then re-run this script."
  exit 1
fi
NODE_VER=$(node -v)
echo "  ✓ Node.js $NODE_VER found"

# Install dependencies
echo ""
echo "  Installing dependencies (this takes ~1 minute the first time)…"
npm install --silent

echo ""
echo "  ✓ All done! Launching the app…"
echo ""
npm start
