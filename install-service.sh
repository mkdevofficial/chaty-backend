#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
  RUN_USER="${SUDO_USER:-root}"
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo is required to install a systemd service." >&2
    exit 1
  fi
  SUDO="sudo"
  RUN_USER="$(id -un)"
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "Node.js was not found. Run ./start.sh once to install Node.js and dependencies." >&2
  exit 1
fi

mkdir -p data uploads
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  if [ -f package-lock.json ]; then
    npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
  else
    npm install --omit=dev --no-audit --no-fund
  fi
fi

$SUDO chown -R "$RUN_USER":"$RUN_USER" data uploads

SERVICE_FILE="/etc/systemd/system/chaty.service"
$SUDO tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Chaty backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$NODE_BIN $APP_DIR/src/server.js
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=15
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now chaty

echo "Installed and started chaty.service (runs as $RUN_USER)."
echo "Status:  sudo systemctl status chaty"
echo "Logs:    sudo journalctl -u chaty -f"
echo "Restart: sudo systemctl restart chaty"
