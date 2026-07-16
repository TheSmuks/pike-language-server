#!/usr/bin/env bash
set -euo pipefail

# Stage the npm package in dist-npm/ and pack it.
#
# Usage: bash scripts/build-npm-package.sh
# Output: dist-npm/pike-language-server-<version>.tgz  (+ the staged package)
#
# A generated manifest is staged rather than publishing the repo's package.json,
# mirroring build-vsix.sh. Three reasons, each of which broke a real install:
#
#   1. Version. `.template-version` is canonical; package.json's version is
#      deliberately decoupled and stale (see bump-version.sh), so publishing it
#      would ship the wrong version forever.
#   2. postinstall. The repo's postinstall fixes a pike-fmt CLI symlink for
#      development checkouts. It is not in the published file list, so npm
#      aborted the install with MODULE_NOT_FOUND.
#   3. dependencies. Everything is bundled into standalone/server.js, so
#      declaring runtime deps would make users download a dependency tree
#      (including pike-fmt's own postinstall) that the package never loads.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$ROOT/dist-npm"
VERSION="$(tr -d '[:space:]' < "$ROOT/.template-version")"

if [ ! -f "$ROOT/standalone/server.js" ]; then
  echo "standalone/server.js missing — run 'bun run build:standalone' first" >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/bin" "$OUT_DIR/standalone" "$OUT_DIR/docs"

cp "$ROOT/bin/pike-language-server" "$OUT_DIR/bin/"
chmod +x "$OUT_DIR/bin/pike-language-server"
cp "$ROOT/standalone/server.js" "$OUT_DIR/standalone/"
cp "$ROOT/standalone/"*.wasm "$OUT_DIR/standalone/"
cp "$ROOT/standalone/"*.json "$OUT_DIR/standalone/"
cp "$ROOT/LICENSE" "$OUT_DIR/"
cp "$ROOT/docs/helix-installation.md" "$ROOT/docs/other-editors.md" "$OUT_DIR/docs/"

cat > "$OUT_DIR/README.md" <<EOF
# Pike Language Server

Tier-3 LSP implementation for [Pike](https://pike.lysator.liu.se/), for any
LSP-capable editor. Runs on Node 18+ or Bun — nothing to build.

## Install

    npm install -g pike-language-server

## Use

    pike-language-server --stdio

### Helix — \`~/.config/helix/languages.toml\`

    [language-server.pike-lsp]
    command = "pike-language-server"
    args = ["--stdio"]

    [[language]]
    name = "pike"
    scope = "source.pike"
    file-types = ["pike", "pmod", "mmod"]
    comment-token = "//"
    indent = { tab-width = 2, unit = "  " }
    roots = ["pike.json", ".git"]
    language-servers = ["pike-lsp"]

Full guide, including syntax highlighting:
[docs/helix-installation.md](docs/helix-installation.md)

### Neovim and other clients

[docs/other-editors.md](docs/other-editors.md)

## Diagnostics

Install [Pike](https://pike.lysator.liu.se/) 8.0+ and keep \`pike\` on PATH.
Every other feature works without it.

## VS Code

Use the
[marketplace extension](https://marketplace.visualstudio.com/items?itemName=thesmuks.pike-language-server)
instead — this package is for other editors.
EOF

# Generated manifest: no scripts (no postinstall), no dependencies (all bundled).
node - "$OUT_DIR" "$VERSION" <<'NODE'
const { writeFileSync } = require("node:fs");
const [outDir, version] = process.argv.slice(2);
const manifest = {
  name: "pike-language-server",
  version,
  description: "Tier-3 LSP implementation for Pike — for Helix, Neovim, and any LSP-capable editor",
  type: "module",
  bin: { "pike-language-server": "./bin/pike-language-server" },
  engines: { node: ">=18" },
  license: "MIT",
  repository: { type: "git", url: "git+https://github.com/TheSmuks/pike-language-server.git" },
  homepage: "https://github.com/TheSmuks/pike-language-server#readme",
  bugs: { url: "https://github.com/TheSmuks/pike-language-server/issues" },
  keywords: ["pike", "lsp", "language-server", "helix", "neovim", "vim", "editor"],
  files: ["bin/", "standalone/", "docs/", "README.md", "LICENSE"],
};
writeFileSync(`${outDir}/package.json`, JSON.stringify(manifest, null, 2) + "\n");
NODE

cd "$OUT_DIR"
npm pack --pack-destination "$OUT_DIR" >/dev/null

echo "npm package staged: $OUT_DIR"
echo "packed: $(ls "$OUT_DIR"/*.tgz)"
