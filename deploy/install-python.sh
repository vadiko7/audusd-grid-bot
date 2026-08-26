#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m venv .venv
.venv/bin/pip install -U pip
.venv/bin/pip install git+https://github.com/elliottech/lighter-python.git
.venv/bin/python -c "import lighter; print('lighter ok')"
