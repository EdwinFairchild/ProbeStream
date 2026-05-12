#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

DIST_DIR="${1:-../../probestream-tui-dist}"
mkdir -p "$DIST_DIR"

echo "=== Building ProbeStream TUI ==="
bun build src/index.tsx --compile --outfile "$DIST_DIR/probestream-tui"

cp scripts/sidecar.sh "$DIST_DIR/"
cp -r sidecar/ "$DIST_DIR/sidecar/"
chmod +x "$DIST_DIR/probestream-tui" "$DIST_DIR/sidecar.sh"

echo "=== Done: $DIST_DIR ==="
ls -la "$DIST_DIR"
