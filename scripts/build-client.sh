#!/usr/bin/env bash
# Build the VSCode extension client bundle.
# Injects a unique build number (last 6 digits of epoch seconds) at compile time
# via esbuild --define, so the extension can log it on activation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

BUILD_NUM=$(date +%s | tail -c 7)

esbuild "$ROOT/client/extension.ts" \
  --bundle \
  --outfile="$ROOT/client/dist/extension.cjs" \
  --out-extension:.js=.cjs \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --sourcemap \
  --external:vscode \
  --define:BUILD_NUMBER="\"$BUILD_NUM\""

# esbuild converts import.meta to `var import_meta = {}` for CJS format,
# which breaks web-tree-sitter's WASM resolution (import_meta.url is undefined).
# Replace the empty object with a proper URL polyfill.
sed -i 's/var import_meta = {}/var import_meta = { url: require("url").pathToFileURL(__filename).href }/' \
  "$ROOT/client/dist/extension.cjs"
