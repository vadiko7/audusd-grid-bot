#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! python3 -c "import venv" 2>/dev/null; then
  echo "need python3-venv: sudo apt-get install -y python3-venv python3-full"
  exit 1
fi
python3 -m venv .venv
.venv/bin/pip install -U pip
.venv/bin/pip install git+https://github.com/elliottech/lighter-python.git
.venv/bin/python -c "from lighter.signer_client import SignerClient; print('lighter ok')"
echo "restart: sudo systemctl restart audusd-grid"
