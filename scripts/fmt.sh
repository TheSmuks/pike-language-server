#!/usr/bin/env bash
# Wrapper around pike-fmt for this repo.
# Usage:
#   bash scripts/fmt.sh --check   # CI: check formatting, exit 1 on failures
#   bash scripts/fmt.sh --write   # Format in-place

set -euo pipefail

# Navigate to project root (parent of scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$SCRIPT_DIR"

PIKE_FMT_WASM="$SCRIPT_DIR/node_modules/pike-fmt/dist/tree-sitter-pike.wasm" \
  bun run node_modules/pike-fmt/dist/cli.js \
  "$@" corpus/
