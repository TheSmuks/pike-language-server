#!/usr/bin/env bash
set -euo pipefail

# Package the standalone bundle as a release tarball, so users can install
# without cloning or building. Requires Bun on the user's machine (the binary
# built by build-binary.sh requires nothing at all).
#
# Usage: bash scripts/build-tarball.sh
# Output: dist-tarball/pike-language-server-standalone-<version>.tar.gz
#
# Layout inside the archive (a single top-level directory, so `tar xz` never
# litters the user's cwd):
#
#   pike-language-server/
#     server.js               <- entry; run with: bun server.js --stdio
#     tree-sitter-pike.wasm   <- resolved relative to server.js at runtime
#     web-tree-sitter.wasm
#     *.json                  <- stdlib/predef indexes
#     README.md               <- how to wire it into an editor

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$ROOT/dist-tarball"
STAGE="$OUT_DIR/pike-language-server"
# .template-version is the canonical release version. package.json's version is
# deliberately decoupled from it (see bump-version.sh) and is stale by design —
# reading it here would label the artifact with the wrong release.
VERSION="$(tr -d '[:space:]' < "$ROOT/.template-version")"
TARBALL="$OUT_DIR/pike-language-server-standalone-$VERSION.tar.gz"

if [ ! -f "$ROOT/standalone/server.js" ]; then
  echo "standalone/server.js missing — run 'bun run build:standalone' first" >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$STAGE"

# Ship the runtime assets only. The .map is 3.9MB of no use to users.
cp "$ROOT/standalone/server.js" "$STAGE/"
cp "$ROOT/standalone/"*.wasm "$STAGE/"
cp "$ROOT/standalone/"*.json "$STAGE/"
# The Pike runtime — see build-standalone.sh. Absence degrades silently, so it
# is an error here rather than a missing file nobody notices.
if [ ! -d "$ROOT/standalone/pike" ]; then
  echo "standalone/pike missing — run 'bun run build:standalone' first" >&2
  exit 1
fi
mkdir -p "$STAGE/pike"
# Copy the whole runtime dir: it carries Introspect.pmod as a DIRECTORY
# alongside the .pike files, and a *.pike glob silently drops it.
cp -R "$ROOT/standalone/pike/." "$STAGE/pike/"

cat > "$STAGE/README.md" <<EOF
# Pike Language Server — standalone bundle $VERSION

Requires [Bun](https://bun.sh/) on PATH. For diagnostics, also install
[Pike](https://pike.lysator.liu.se/) 8.0+.

Run it:

    bun /path/to/pike-language-server/server.js --stdio

Keep the .wasm and .json files next to server.js — they are resolved relative
to it at runtime.

## Helix

Add to \`~/.config/helix/languages.toml\`:

    [language-server.pike-lsp]
    command = "bun"
    args = ["/path/to/pike-language-server/server.js", "--stdio"]

    [[language]]
    name = "pike"
    scope = "source.pike"
    file-types = ["pike", "pmod", "mmod"]
    comment-token = "//"
    indent = { tab-width = 2, unit = "  " }
    roots = ["pike.json", ".git"]
    language-servers = ["pike-lsp"]

Full guide, including syntax highlighting:
https://github.com/TheSmuks/pike-language-server/blob/main/docs/helix-installation.md

## Neovim and other clients

https://github.com/TheSmuks/pike-language-server/blob/main/docs/other-editors.md

Prefer no runtime at all? Download a native binary from the same release —
it needs neither Bun nor Node.
EOF

tar -czf "$TARBALL" -C "$OUT_DIR" pike-language-server
rm -rf "$STAGE"

echo "Tarball complete: $TARBALL"
ls -lh "$TARBALL"
