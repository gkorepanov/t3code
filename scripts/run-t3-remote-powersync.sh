#!/usr/bin/env bash
set -euo pipefail

# Start a remote t3 serve stack with Postgres + self-hosted PowerSync.
#
# Usage:
#   PUBLIC_HOST=your.server.ip.or.domain bash scripts/run-t3-remote-powersync.sh
#   LOCAL_ONLY=1 bash scripts/run-t3-remote-powersync.sh
#
# Ports:
#   3773 = t3 serve
#   8080 = PowerSync
#   Postgres is bound only to 127.0.0.1.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

LOCAL_ONLY="${LOCAL_ONLY:-0}"
if [ "$LOCAL_ONLY" = "1" ]; then
  PUBLIC_HOST="${PUBLIC_HOST:-127.0.0.1}"
  T3_HOST="${T3_HOST:-127.0.0.1}"
else
  PUBLIC_HOST="${PUBLIC_HOST:-$(hostname -I | awk '{print $1}')}"
  T3_HOST="${T3_HOST:-0.0.0.0}"
fi
T3_PORT="${T3_PORT:-3773}"
PS_PORT="${PS_PORT:-8080}"
PG_PORT="${PG_PORT:-54329}"
T3_HOME="${T3_HOME:-$HOME/.t3code-remote}"

ENGINE="${CONTAINER_ENGINE:-}"
if [ -z "$ENGINE" ]; then
  if command -v docker >/dev/null 2>&1; then
    ENGINE=docker
  elif command -v podman >/dev/null 2>&1; then
    ENGINE=podman
  else
    echo "Install docker or podman"
    exit 1
  fi
fi

if [ "$ENGINE" = "podman" ]; then
  POSTGRES_IMAGE="${POSTGRES_IMAGE:-docker.io/library/postgres:16-alpine}"
  POWERSYNC_IMAGE="${POWERSYNC_IMAGE:-docker.io/journeyapps/powersync-service:1.20.5}"
  if [ "$LOCAL_ONLY" = "1" ]; then
    USE_HOST_NETWORK=0
    NETWORK=podman
  else
    USE_HOST_NETWORK=1
    NETWORK=t3code-net
  fi
else
  POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
  POWERSYNC_IMAGE="${POWERSYNC_IMAGE:-journeyapps/powersync-service:1.20.5}"
  USE_HOST_NETWORK=0
  NETWORK=t3code-net
fi

command -v bun >/dev/null 2>&1 || {
  echo "Install bun"
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "Install node >=22.16"
  exit 1
}
command -v openssl >/dev/null 2>&1 || {
  echo "Install openssl"
  exit 1
}
command -v curl >/dev/null 2>&1 || {
  echo "Install curl"
  exit 1
}

mkdir -p "$T3_HOME/powersync"
ENV_FILE="$T3_HOME/server.env"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(openssl rand -hex 24)}"
PS_API_TOKEN="${PS_API_TOKEN:-$(openssl rand -hex 24)}"

cat >"$ENV_FILE" <<EOF
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
PS_API_TOKEN=$PS_API_TOKEN
EOF
chmod 600 "$ENV_FILE"

KEY_FILE="$T3_HOME/powersync/powersync-rs256.pem"
if [ ! -f "$KEY_FILE" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEY_FILE"
  chmod 600 "$KEY_FILE"
fi

PG_NAME=t3code-postgres
PS_NAME=t3code-powersync

if [ "$USE_HOST_NETWORK" = "0" ] && [ "$NETWORK" != "podman" ]; then
  $ENGINE network inspect "$NETWORK" >/dev/null 2>&1 || $ENGINE network create "$NETWORK" >/dev/null
fi

if [ "$USE_HOST_NETWORK" = "1" ]; then
  $ENGINE rm -f "$PG_NAME" >/dev/null 2>&1 || true
fi

if ! $ENGINE container inspect "$PG_NAME" >/dev/null 2>&1; then
  PG_NETWORK_ARGS=(--network "$NETWORK" -p "127.0.0.1:${PG_PORT}:5432")
  PG_PORT_ARGS=()
  if [ "$ENGINE" = "podman" ] && [ "$LOCAL_ONLY" = "1" ]; then
    PG_NETWORK_ARGS=(--network "$NETWORK" -p "127.0.0.1:${PG_PORT}:5432")
  fi
  if [ "$USE_HOST_NETWORK" = "1" ]; then
    PG_NETWORK_ARGS=(--network host)
    PG_PORT_ARGS=(-c "port=${PG_PORT}" -c "listen_addresses=127.0.0.1")
  fi

  $ENGINE run -d --name "$PG_NAME" "${PG_NETWORK_ARGS[@]}" \
    -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    -e POSTGRES_DB=t3code \
    -v t3code-postgres-data:/var/lib/postgresql/data \
    "$POSTGRES_IMAGE" \
    "${PG_PORT_ARGS[@]}" \
    -c wal_level=logical \
    -c max_replication_slots=16 \
    -c max_wal_senders=16 >/dev/null
else
  $ENGINE start "$PG_NAME" >/dev/null
fi

until $ENGINE exec "$PG_NAME" pg_isready -U postgres -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1; do
  sleep 1
done

if ! $ENGINE exec "$PG_NAME" psql -U postgres -h 127.0.0.1 -p "$PG_PORT" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='powersync_storage'" | grep -q 1; then
  $ENGINE exec "$PG_NAME" createdb -U postgres -h 127.0.0.1 -p "$PG_PORT" powersync_storage
fi

if [ "${T3_SKIP_BUILD:-0}" != "1" ]; then
  bun install --frozen-lockfile
  (cd apps/web && bun run build)
  (cd apps/server && bun run build)
fi

export T3CODE_DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${PG_PORT}/t3code"
export T3CODE_POWERSYNC_URL="http://${PUBLIC_HOST}:${PS_PORT}"
export T3CODE_POWERSYNC_JWT_PRIVATE_KEY="$(awk '{printf "%s\\n",$0}' "$KEY_FILE")"
export T3CODE_POWERSYNC_JWT_ISSUER="t3code"
export T3CODE_POWERSYNC_JWT_AUDIENCE="powersync"
export T3CODE_NO_BROWSER=1

node apps/server/dist/bin.mjs serve --host "$T3_HOST" --port "$T3_PORT" --base-dir "$T3_HOME" &
T3_PID=$!
trap 'kill "$T3_PID" 2>/dev/null || true' EXIT INT TERM

until curl --max-time 5 -fsS "http://127.0.0.1:${T3_PORT}/.well-known/t3/environment" >/dev/null; do
  sleep 1
done

$ENGINE exec "$PG_NAME" psql -U postgres -h 127.0.0.1 -p "$PG_PORT" -d t3code -v ON_ERROR_STOP=1 -c \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'powersync') THEN CREATE PUBLICATION powersync FOR ALL TABLES; END IF; END \$\$;"

HOST_INTERNAL=host.containers.internal
ADD_HOST_ARGS=()
if [ "$ENGINE" = "docker" ]; then
  HOST_INTERNAL=host.docker.internal
  ADD_HOST_ARGS=(--add-host host.docker.internal:host-gateway)
elif [ "$USE_HOST_NETWORK" = "1" ]; then
  HOST_INTERNAL=127.0.0.1
fi

PS_DB_HOST="$PG_NAME"
PS_DB_PORT=5432
PS_NETWORK_ARGS=(--network "$NETWORK" -p "${PS_PORT}:8080")
if [ "$LOCAL_ONLY" = "1" ]; then
  PS_NETWORK_ARGS=(--network "$NETWORK" -p "127.0.0.1:${PS_PORT}:8080")
  if [ "$ENGINE" = "podman" ]; then
    PS_DB_HOST=host.containers.internal
    PS_DB_PORT="$PG_PORT"
  fi
fi
if [ "$USE_HOST_NETWORK" = "1" ]; then
  PS_DB_HOST=127.0.0.1
  PS_DB_PORT="$PG_PORT"
  PS_NETWORK_ARGS=(--network host)
fi

cat >"$T3_HOME/powersync/service.yaml" <<EOF
telemetry:
  disable_telemetry_sharing: true
replication:
  connections:
    - type: postgresql
      uri: postgresql://postgres:${POSTGRES_PASSWORD}@${PS_DB_HOST}:${PS_DB_PORT}/t3code
      sslmode: disable
storage:
  type: postgresql
  uri: postgresql://postgres:${POSTGRES_PASSWORD}@${PS_DB_HOST}:${PS_DB_PORT}/powersync_storage
  sslmode: disable
port: 8080
sync_config:
  path: /config/sync-rules.yaml
client_auth:
  jwks_uri: http://${HOST_INTERNAL}:${T3_PORT}/api/powersync/jwks
  audience: ["powersync", "t3code-powersync"]
api:
  tokens:
    - ${PS_API_TOKEN}
system:
  logging:
    level: info
    format: text
EOF

cp powersync/sync-rules.yaml "$T3_HOME/powersync/sync-rules.yaml"

$ENGINE rm -f "$PS_NAME" >/dev/null 2>&1 || true
$ENGINE run -d --name "$PS_NAME" "${PS_NETWORK_ARGS[@]}" \
  "${ADD_HOST_ARGS[@]}" \
  -v "$T3_HOME/powersync:/config:ro" \
  "$POWERSYNC_IMAGE" start -c /config/service.yaml >/dev/null

until curl --max-time 5 -fsS "http://127.0.0.1:${PS_PORT}/probes/liveness" >/dev/null; do
  sleep 1
done

echo "t3:        http://${PUBLIC_HOST}:${T3_PORT}"
echo "PowerSync: http://${PUBLIC_HOST}:${PS_PORT}"
echo "Open firewall/reverse proxy for ${T3_PORT} and ${PS_PORT}. Postgres stays local."

wait "$T3_PID"
