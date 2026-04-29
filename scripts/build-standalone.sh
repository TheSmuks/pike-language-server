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

# Bundle server with esbuild (no vscode externals needed for standalone)
npx esbuild "$ROOT/server/src/server.ts" \
  --bundle \
  --outfile="$OUT_DIR/server.js" \
  --platform=node \
  --target=node22 \
  --format=esm \
  --sourcemap \
  --external:vscode \
  --external:vscode-* \
  --banner:js='// Pike Language Server — standalone build'

# Copy WASM grammar
cp "$ROOT/server/tree-sitter-pike.wasm" "$OUT_DIR/"

# Copy web-tree-sitter runtime WASM
cp "$ROOT/node_modules/web-tree-sitter/web-tree-sitter.wasm" "$OUT_DIR/"

# Copy data files
cp "$ROOT/server/src/data/"*.json "$OUT_DIR/"

echo "Standalone build complete: $OUT_DIR/"
echo "Run with: bun $OUT_DIR/server.js --stdio"
ls -lh "$OUT_DIR/"
