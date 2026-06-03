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

# The bundled parser resolves WASM assets relative to server.mjs at runtime.
# esbuild does not copy these assets unless they are imported directly, so keep
# the runtime contract explicit for VSIX and headless integration tests.
install -m 0644 \
  "$ROOT/server/tree-sitter-pike.wasm" \
  "$ROOT/server/dist/tree-sitter-pike.wasm"
install -m 0644 \
  "$ROOT/node_modules/web-tree-sitter/web-tree-sitter.wasm" \
  "$ROOT/server/dist/web-tree-sitter.wasm"
