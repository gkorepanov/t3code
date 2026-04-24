#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT_DIR/apps/server"
DEFAULT_PORT=3773

resolve_port() {
  local port="$DEFAULT_PORT"
  local previous=""
  for arg in "$@"; do
    if [[ "$previous" == "--port" ]]; then
      port="$arg"
      break
    fi
    if [[ "$arg" == --port=* ]]; then
      port="${arg#--port=}"
      break
    fi
    previous="$arg"
  done
  printf '%s\n' "$port"
}

stop_existing_server_on_port() {
  local port="$1"
  local pid=""
  pid="$(
    ss -ltnp "( sport = :$port )" 2>/dev/null \
      | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' \
      | head -n 1
  )"

  if [[ -z "$pid" ]]; then
    return
  fi

  local process_cwd=""
  process_cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  if [[ "$process_cwd" != "$SERVER_DIR" ]]; then
    printf 'Port %s is already in use by pid %s (%s); refusing to stop it.\n' \
      "$port" "$pid" "${process_cwd:-unknown cwd}" >&2
    exit 1
  fi

  printf 'Stopping existing T3 server on port %s (pid %s).\n' "$port" "$pid"
  kill "$pid"
  while ss -ltn "( sport = :$port )" 2>/dev/null | grep -q ":$port"; do
    sleep 0.1
  done
}

cd "$ROOT_DIR/apps/web"
bun run build

cd "$SERVER_DIR"
bun run build

PORT="$(resolve_port "$@")"
stop_existing_server_on_port "$PORT"

exec node dist/bin.mjs "$@"
