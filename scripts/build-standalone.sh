#!/usr/bin/env bash
set -euo pipefail

# Build a standalone server bundle for non-VSCode LSP clients.
# Output: standalone/ directory with server.js, tree-sitter-pike.wasm, and data files.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$ROOT/standalone"

echo "Building standalone server to $OUT_DIR..."

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# Bundle the server. Only `vscode` itself is external — it is the extension-host
# API and does not exist outside VSCode; nothing in the server imports it.
#
# `vscode-languageserver`/`vscode-jsonrpc` are ordinary npm packages and MUST be
# bundled: marking them external left server.js importing them from
# node_modules at runtime, so the bundle only ran from inside a checkout and any
# copy of it elsewhere died with "Cannot find module
# 'vscode-languageserver-protocol/lib/common/api'".
# The createRequire banner is required, not cosmetic: esbuild's ESM output
# cannot satisfy the dynamic require() that web-tree-sitter's emscripten glue
# performs, so under plain Node the bundle died with "Dynamic require of 'fs'
# is not supported". With the shim it runs on Node and Bun alike, which is what
# lets the npm package work without Bun.
esbuild "$ROOT/server/src/main.ts" \
  --bundle \
  --outfile="$OUT_DIR/server.js" \
  --platform=node \
  --target=node22 \
  --format=esm \
  --sourcemap \
  --external:vscode \
  --banner:js="// Pike Language Server — standalone build
import{createRequire as __pikeCreateRequire}from'node:module';const require=__pikeCreateRequire(import.meta.url);"

# Copy WASM grammar
cp "$ROOT/server/tree-sitter-pike.wasm" "$OUT_DIR/"

# Copy web-tree-sitter runtime WASM
cp "$ROOT/node_modules/web-tree-sitter/web-tree-sitter.wasm" "$OUT_DIR/"

# Copy data files
cp "$ROOT/server/src/data/"*.json "$OUT_DIR/"

echo "Standalone build complete: $OUT_DIR/"
echo "Run with: bun $OUT_DIR/server.js --stdio"
ls -lh "$OUT_DIR/"
