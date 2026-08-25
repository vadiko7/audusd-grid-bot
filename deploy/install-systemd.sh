#!/bin/bash
set -euo pipefail
ROOT=/home/ubuntu/audusd-grid-bot
if [[ ! -f "$ROOT/.env" ]]; then
  echo "missing $ROOT/.env — copy .env.example once and fill keys. Do not re-enter on every start."
  exit 1
fi
if [[ ! -x /usr/bin/node ]]; then
  echo "node not found at /usr/bin/node"
  exit 1
fi
sudo cp "$ROOT/deploy/audusd-grid.service" /etc/systemd/system/audusd-grid.service
sudo systemctl daemon-reload
sudo systemctl enable audusd-grid
sudo systemctl restart audusd-grid
sudo systemctl --no-pager --full status audusd-grid
