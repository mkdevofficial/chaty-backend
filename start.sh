#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

node_is_supported() {
  command -v node >/dev/null 2>&1 &&
    node -e 'process.exit(parseInt(process.versions.node, 10) >= 20 ? 0 : 1)' >/dev/null 2>&1
}

if ! node_is_supported; then
  echo "Node.js 20+ was not found. Installing Node.js 20 from NodeSource..."
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "This installer supports Debian/Ubuntu (apt-get). Please install Node.js 20+ manually." >&2
    exit 1
  fi

  if [ "$(id -u)" -eq 0 ]; then
    apt-get update -y
    apt-get install -y curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    if ! command -v sudo >/dev/null 2>&1; then
      echo "Root privileges are required to install Node.js. Re-run as root or install Node.js 20+ manually." >&2
      exit 1
    fi
    sudo apt-get update -y
    sudo apt-get install -y curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
fi

if ! node_is_supported; then
  echo "Node.js 20+ is still not available after installation. Aborting." >&2
  exit 1
fi

mkdir -p data uploads

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example (port 5050)."
fi

echo "Installing dependencies..."
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi

echo "Starting chaty backend on port $(grep -E '^PORT=' .env | tail -n1 | cut -d= -f2 | tr -d '[:space:]' || echo 5050)..."
exec node src/server.js
