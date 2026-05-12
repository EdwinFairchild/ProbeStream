#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SIDECAR_DIR="$SCRIPT_DIR/../sidecar"

HOST="${PSTUI_SIDECAR_HOST:-127.0.0.1}"
PORT="${PSTUI_SIDECAR_PORT:-17900}"

exec python3 "$SIDECAR_DIR/pstui_sidecar.py" \
  --host "$HOST" \
  --port "$PORT" \
  "$@"
