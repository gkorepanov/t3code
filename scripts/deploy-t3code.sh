#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

git pull --ff-only
npx -y bun@1.3.9 install --frozen-lockfile
npx -y bun@1.3.9 run --cwd apps/web build
npx -y bun@1.3.9 run --cwd apps/server build
sudo systemctl restart t3code
sudo systemctl --no-pager --full status t3code
