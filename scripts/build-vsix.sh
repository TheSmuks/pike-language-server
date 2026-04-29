#!/usr/bin/env bash
set -euo pipefail

# Package the VSCode extension as a .vsix file.
# Output: pike-language-server-<version>.vsix

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
STAGE="$ROOT/.vsix-stage"

# Read version from extension manifest
VERSION=$(node -e "console.log(require('$ROOT/extension.package.json').version)")
VSIX_NAME="pike-language-server-${VERSION}.vsix"

echo "Packaging pike-language-server v${VERSION}..."

# Clean stage
rm -rf "$STAGE"
mkdir -p "$STAGE"

# Copy extension manifest as package.json
cp "$ROOT/extension.package.json" "$STAGE/package.json"

# Copy extension client
mkdir -p "$STAGE/client/dist"
cp "$ROOT/client/dist/extension.js" "$STAGE/client/dist/"
cp "$ROOT/client/dist/extension.js.map" "$STAGE/client/dist/"

# Copy server
mkdir -p "$STAGE/server/dist"
cp "$ROOT/server/dist/server.js" "$STAGE/server/dist/"
cp "$ROOT/server/dist/server.js.map" "$STAGE/server/dist/"

# Copy WASM grammar
cp "$ROOT/server/tree-sitter-pike.wasm" "$STAGE/server/"

# Copy data files
mkdir -p "$STAGE/server/src/data"
cp "$ROOT/server/src/data/"*.json "$STAGE/server/src/data/"

# Copy web-tree-sitter runtime WASM (needed by server)
cp "$ROOT/node_modules/web-tree-sitter/web-tree-sitter.wasm" "$STAGE/server/dist/"

# Copy icon if exists
if [ -f "$ROOT/icon.png" ]; then
  cp "$ROOT/icon.png" "$STAGE/"
fi

# Copy LICENSE
cp "$ROOT/LICENSE" "$STAGE/"

# Create .vscodeignore to keep the vsix small
cat > "$STAGE/.vscodeignore" << 'EOF'
**/*.map
.gitignore
**/test/**
**/tests/**
**/harness/**
**/corpus/**
**/docs/**
**/decisions/**
**/scripts/**
**/standalone/**
**/bin/**
**/*.md
!README.md
!LICENSE
EOF

echo "Stage directory:"
du -sh "$STAGE"
du -sh "$STAGE"/* | sort -rh | head -10

# Package with vsce
cd "$STAGE"
npx @vscode/vsce package --no-dependencies -o "$ROOT/$VSIX_NAME" 2>&1

cd "$ROOT"
rm -rf "$STAGE"

echo ""
echo "VSIX: $ROOT/$VSIX_NAME"
ls -lh "$VSIX_NAME"
