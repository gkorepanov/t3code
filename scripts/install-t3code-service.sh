#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

sudo install -m 0644 scripts/t3code.service /etc/systemd/system/t3code.service
sudo systemctl daemon-reload
sudo systemctl enable --now t3code
sudo systemctl --no-pager --full status t3code
