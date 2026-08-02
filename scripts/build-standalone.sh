#!/usr/bin/env bash
set -euo pipefail

# Build a standalone server bundle for non-VSCode LSP clients.
# Output: standalone/ directory with server.js, tree-sitter-pike.wasm, and data files.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$ROOT/standalone"

# Resolve esbuild explicitly. A bare `esbuild` only works when the script is
# invoked through `bun run`, which puts node_modules/.bin on PATH; called
# directly (as check-distributions.sh and CI do) it failed with
# "esbuild: command not found" and exit 127.
ESBUILD="$ROOT/node_modules/.bin/esbuild"
if [ ! -x "$ESBUILD" ]; then
  ESBUILD="$(command -v esbuild || true)"
fi
if [ -z "$ESBUILD" ]; then
  echo "esbuild not found — run 'bun install' first" >&2
  exit 1
fi

# .template-version is the canonical release version; package.json's version
# is deliberately stale (see bump-version.sh) and must never be stamped here.
VERSION="$(tr -d '[:space:]' < "$ROOT/.template-version")"

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
"$ESBUILD" "$ROOT/server/src/main.ts" \
  --bundle \
  --outfile="$OUT_DIR/server.js" \
  --platform=node \
  --target=node22 \
  --format=esm \
  --sourcemap \
  --external:vscode \
  --define:__PIKE_LSP_VERSION__="\"$VERSION\"" \
  --banner:js="// Pike Language Server — standalone build
import{createRequire as __pikeCreateRequire}from'node:module';const require=__pikeCreateRequire(import.meta.url);"

# Copy WASM grammar
cp "$ROOT/server/tree-sitter-pike.wasm" "$OUT_DIR/"

# Copy web-tree-sitter runtime WASM
cp "$ROOT/node_modules/web-tree-sitter/web-tree-sitter.wasm" "$OUT_DIR/"

# Copy data files
cp "$ROOT/server/src/data/"*.json "$OUT_DIR/"

# Copy the Pike runtime the worker is spawned with. Without it the server
# silently degrades to tree-sitter only — no compiler diagnostics, no typeof,
# no resolve, no autodoc — which is how the Neovim/Helix path ran for a while.
# scripts/check-standalone.mjs asserts this is here.
mkdir -p "$OUT_DIR/pike"
cp "$ROOT/server/pike/worker.pike" "$OUT_DIR/pike/"
cp "$ROOT/server/pike/Common.pike" "$OUT_DIR/pike/"

echo "Standalone build complete: $OUT_DIR/"
echo "Run with: bun $OUT_DIR/server.js --stdio"
ls -lh "$OUT_DIR/"
