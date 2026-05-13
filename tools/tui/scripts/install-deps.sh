#!/usr/bin/env bash
# install-deps.sh — install bun (if missing) and TUI npm dependencies
set -euo pipefail

BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
BUN_BIN="$BUN_INSTALL/bin/bun"

# ── 1. Ensure bun is available ────────────────────────────────────────────────

if command -v bun &>/dev/null; then
  echo "bun already in PATH: $(command -v bun)  ($(bun --version))"
else
  if [[ -x "$BUN_BIN" ]]; then
    echo "bun found at $BUN_BIN but not in PATH — adding for this session"
  else
    echo "Installing bun..."
    curl -fsSL https://bun.sh/install | bash
  fi

  # Make it available for the rest of this script
  export PATH="$BUN_BIN:$PATH"
  echo "bun $(bun --version) ready"
fi

# ── 2. Persist bun in PATH across login shells ────────────────────────────────

SHELL_RC=""
case "${SHELL:-}" in
  */bash) SHELL_RC="$HOME/.bashrc" ;;
  */zsh)  SHELL_RC="$HOME/.zshrc"  ;;
esac

BUN_PATH_LINE='export PATH="$HOME/.bun/bin:$PATH"'

if [[ -n "$SHELL_RC" ]]; then
  if grep -qF '.bun/bin' "$SHELL_RC" 2>/dev/null; then
    echo "bun PATH entry already present in $SHELL_RC"
  else
    echo "" >> "$SHELL_RC"
    echo "# added by ProbeStream TUI install-deps.sh" >> "$SHELL_RC"
    echo "$BUN_PATH_LINE" >> "$SHELL_RC"
    echo "Added bun to PATH in $SHELL_RC  (re-open your terminal or: source $SHELL_RC)"
  fi
else
  echo "Could not detect shell rc file — add this line manually to your shell profile:"
  echo "  $BUN_PATH_LINE"
fi

# Also write to .profile as a fallback for login shells / display managers
if [[ -f "$HOME/.profile" ]] && ! grep -qF '.bun/bin' "$HOME/.profile" 2>/dev/null; then
  echo "" >> "$HOME/.profile"
  echo "# added by ProbeStream TUI install-deps.sh" >> "$HOME/.profile"
  echo "$BUN_PATH_LINE" >> "$HOME/.profile"
  echo "Also added bun to PATH in ~/.profile"
fi

# ── 3. Install npm dependencies ───────────────────────────────────────────────

cd "$(dirname "$0")/.."
echo "Running: bun install"
bun install

echo ""
echo "All done.  To start the TUI:"
echo "  cd tools/tui && bun run dev"
echo "or"
echo "  cd tools/tui && ./scripts/dev.sh"
