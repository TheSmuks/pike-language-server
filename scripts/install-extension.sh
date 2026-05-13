#!/usr/bin/env bash
set -euo pipefail

# Build and install the Pike Language Server extension into VSCode.
#
# Usage: bash scripts/install-extension.sh [--skip-tests] [--editor-cmd <path>]
#
# Options:
#   --skip-tests       Skip typecheck (use when you've already verified)
#   --editor-cmd      Path to editor CLI (default: auto-detect code/code-insiders/codium)
#
# Exit codes:
#   0  Success
#   1  Build or install failure
#   2  No compatible editor found

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

SKIP_TESTS=false
EDITOR_CMD=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tests)  SKIP_TESTS=true; shift ;;
    --editor-cmd)  EDITOR_CMD="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: bash scripts/install-extension.sh [--skip-tests] [--editor-cmd <path>]"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done

# --- Phase 1: Verify ---
if [[ "$SKIP_TESTS" == false ]]; then
  echo "==> Typechecking..."
  bun run typecheck
fi

# --- Phase 2: Build and Package ---
# build-vsix.sh handles both building (bun run build:extension) and packaging,
# so we delegate the entire build+package step to it.
echo "==> Building and packaging VSIX..."
bash "$SCRIPT_DIR/build-vsix.sh"
VSIX=$(cat "$ROOT/out/.latest-vsix" 2>/dev/null || true)
rm -f "$ROOT/out/.latest-vsix"
if [[ -z "$VSIX" || ! -f "$VSIX" ]]; then
  echo "ERROR: VSIX not found (build-vsix.sh may have failed)"
  exit 1
fi

# --- Phase 3: Detect editor ---
if [[ -z "$EDITOR_CMD" ]]; then
  for cmd in code code-insiders codium; do
    if command -v "$cmd" &>/dev/null; then
      EDITOR_CMD="$cmd"
      break
    fi
  done
fi

if [[ -z "$EDITOR_CMD" ]]; then
  echo "ERROR: No VSCode-compatible editor found. Install one of: code, code-insiders, codium"
  echo "       Or pass --editor-cmd /path/to/editor-cli"
  exit 2
fi

# --- Phase 4: Install ---
echo "==> Installing into $EDITOR_CMD..."
if "$EDITOR_CMD" --install-extension "$VSIX"; then
  echo ""
  echo "✓ Pike Language Server installed."
  echo "  Restart VSCode (or reload window) to activate."
else
  INSTALL_EXIT=$?
  echo ""
  echo "✗ Installation failed (exit code: $INSTALL_EXIT)."
  echo "  Try: $EDITOR_CMD --install-extension '$VSIX'"
  echo "  Or manually: File > Install from VSIX..."
  exit 1
fi