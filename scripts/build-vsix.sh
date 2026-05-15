#!/usr/bin/env bash
set -euo pipefail

# Package the VSCode extension as a .vsix file.
# Output: pike-language-server-<version>.vsix

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
STAGE="$ROOT/out/.vsix-stage"

# Read version from extension manifest.
# Strip any existing build suffix (+NNNNNNN) to prevent doubling when
# extension.package.json was left with a build-suffixed version from a
# previous interrupted run or manual edit.
RAW_VERSION=$(node -e "console.log(require('$ROOT/extension.package.json').version)")
VERSION="${RAW_VERSION%%+*}"
VERSION="${VERSION%%-*}"
BUILD_NUM=$(date +%s | tail -c 7)
# Use dash, not plus — VS Code's "Install from VSIX" rejects versions
# containing + in some code paths. A dash suffix is a valid semver
# pre-release identifier that installs cleanly.
FULL_VERSION="${VERSION}-${BUILD_NUM}"
VSIX_NAME="pike-language-server-${FULL_VERSION}.vsix"

echo "Packaging pike-language-server v${FULL_VERSION}..."

# Build server and client before packaging.
echo "Building server and client..."
(cd "$ROOT" && bun run build:extension)

# Create output directory
mkdir -p "$ROOT/out"

# Remove stale VSIX files from previous builds.
if ls "$ROOT/out/"*.vsix &>/dev/null; then
  STALE_COUNT=$(ls -1 "$ROOT/out/"*.vsix | wc -l)
  if [[ "$STALE_COUNT" -gt 0 ]]; then
    echo "Removing ${STALE_COUNT} stale VSIX file(s)..."
    rm -f "$ROOT/out/"*.vsix
  fi
fi

# Clean stage
rm -rf "$STAGE"
mkdir -p "$STAGE"

# Copy extension manifest as package.json with build number in version
node -e "
  const pkg = require('$ROOT/extension.package.json');
  pkg.version = '${FULL_VERSION}';
  require('fs').writeFileSync('$STAGE/package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Copy extension client
mkdir -p "$STAGE/client/dist"
cp "$ROOT/client/dist/extension.cjs" "$STAGE/client/dist/extension.cjs"
cp "$ROOT/client/dist/extension.cjs.map" "$STAGE/client/dist/"

# Copy server
mkdir -p "$STAGE/server/dist"
cp "$ROOT/server/dist/server.mjs" "$STAGE/server/dist/"
cp "$ROOT/server/dist/server.mjs.map" "$STAGE/server/dist/"

# Copy WASM grammar
cp "$ROOT/server/tree-sitter-pike.wasm" "$STAGE/server/"

# Copy data files
mkdir -p "$STAGE/server/src/data"
cp "$ROOT/server/src/data/"*.json "$STAGE/server/src/data/"
# Copy harness scripts (needed by pikeWorker.ts at runtime)
if [ -d "$ROOT/harness" ]; then
  mkdir -p "$STAGE/harness"
  cp "$ROOT/harness/"*.pike "$STAGE/harness/"
fi

# Copy web-tree-sitter runtime WASM (needed by server AND client).
# Server resolves relative to server/dist/server.mjs → server/dist/web-tree-sitter.wasm
# Client resolves relative to client/dist/extension.cjs → client/dist/web-tree-sitter.wasm
cp "$ROOT/node_modules/web-tree-sitter/web-tree-sitter.wasm" "$STAGE/server/dist/"
cp "$ROOT/node_modules/web-tree-sitter/web-tree-sitter.wasm" "$STAGE/client/dist/"

# Copy TextMate grammar (instant syntax highlighting before WASM loads)
if [ -d "$ROOT/client/syntaxes" ]; then
  mkdir -p "$STAGE/syntaxes"
  cp "$ROOT/client/syntaxes/"*.json "$STAGE/syntaxes/"
fi

# Copy icon if exists
if [ -f "$ROOT/icon.png" ]; then
  cp "$ROOT/icon.png" "$STAGE/"
fi

# Copy LICENSE
cp "$ROOT/LICENSE" "$STAGE/"
# Copy CHANGELOG for marketplace display
cp "$ROOT/CHANGELOG.md" "$STAGE/"
# Copy README for marketplace display
cp "$ROOT/README.md" "$STAGE/"
# Copy language configuration (required at extension root by extension.ts)
cp "$ROOT/client/language-configuration.json" "$STAGE/"

# Create .vscodeignore to keep the vsix small
cat > "$STAGE/.vscodeignore" << 'EOF'
**/*.map
**/.vscode/**
**/.vscode-test/**
**/node_modules/**
**/out/**
**/src/**
.gitignore
.vscode*
*.vsix
*.ts
*.tsbuildinfo
tsconfig.json
.env
.env.*
*.log
EOF

echo "Stage directory:"
du -sh "$STAGE"
du -sh "$STAGE"/* | sort -rh | head -10

# Package with vsce (resolve from PATH; falls back to bun global bin)
cd "$STAGE"
VSCE_BIN="$(command -v vsce || echo "$HOME/.bun/bin/vsce")"
"$VSCE_BIN" package --no-dependencies -o "$ROOT/out/$VSIX_NAME" 2>&1

cd "$ROOT"
rm -rf "$STAGE"

echo ""
echo "VSIX: $ROOT/out/$VSIX_NAME"
ls -lh "$ROOT/out/$VSIX_NAME"

# Write VSIX path to a marker file so callers (install-extension.sh) can
# find the exact path without parsing stdout.
echo "$ROOT/out/$VSIX_NAME" > "$ROOT/out/.latest-vsix"
