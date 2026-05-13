#!/usr/bin/env bash
# Build the VSCode extension client bundle.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

esbuild "$ROOT/client/extension.ts" \
  --bundle \
  --outfile="$ROOT/client/dist/extension.cjs" \
  --out-extension:.js=.cjs \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --sourcemap \
  --external:vscode

# esbuild converts import.meta to `var import_meta = {}` for CJS format,
# which breaks web-tree-sitter's WASM resolution (import_meta.url is undefined).
# Replace the empty object with a proper URL polyfill.
sed -i 's/var import_meta = {}/var import_meta = { url: require("url").pathToFileURL(__filename).href }/' \
  "$ROOT/client/dist/extension.cjs"
