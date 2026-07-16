#!/usr/bin/env bash
# Wrapper around pike-fmt for this repo.
# Usage:
#   bash scripts/fmt.sh --check   # CI: check formatting, exit 1 on failures
#   bash scripts/fmt.sh --write   # Format in-place

set -euo pipefail

# Navigate to project root (parent of scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$SCRIPT_DIR"

# pike-fmt >= 0.1.10 locates its own wasm assets relative to dist/cli.js, so no
# PIKE_FMT_WASM override is needed. Earlier versions could not: the bundler had
# baked in the build machine's __dirname.
bun run node_modules/pike-fmt/dist/cli.js "$@" corpus/
