#!/usr/bin/env bash
# Build the LSP server bundle.
# Uses a double-quoted banner so inner single quotes in 'module' are safe.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

esbuild "$ROOT/server/src/main.ts" \
  --bundle \
  --outfile="$ROOT/server/dist/server.mjs" \
  --platform=node \
  --target=node22 \
  --format=esm \
  --sourcemap \
  --loader:.wasm=file \
  --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url)"
