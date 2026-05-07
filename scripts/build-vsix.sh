#!/usr/bin/env bash
set -euo pipefail

# Package the VSCode extension as a .vsix file.
# Output: pike-language-server-<version>.vsix

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
STAGE="$ROOT/out/.vsix-stage"

# Read version from extension manifest
VERSION=$(node -e "console.log(require('$ROOT/extension.package.json').version)")
BUILD_NUM=$(date +%s | tail -c 7)
VSIX_NAME="pike-language-server-${VERSION}+${BUILD_NUM}.vsix"

echo "Packaging pike-language-server v${VERSION}+${BUILD_NUM}..."

# Create output directory
mkdir -p "$ROOT/out"

# Clean stage
rm -rf "$STAGE"
mkdir -p "$STAGE"

# Copy extension manifest as package.json
cp "$ROOT/extension.package.json" "$STAGE/package.json"

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

# Copy web-tree-sitter runtime WASM (needed by server AND client)
cp "$ROOT/node_modules/web-tree-sitter/web-tree-sitter.wasm" "$STAGE/server/dist/"

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

# Package with vsce
cd "$STAGE"
npx @vscode/vsce package --no-dependencies -o "$ROOT/out/$VSIX_NAME" 2>&1

cd "$ROOT"
rm -rf "$STAGE"

echo ""
echo "VSIX: $ROOT/out/$VSIX_NAME"
echo "VSIX: $ROOT/out/$VSIX_NAME"
ls -lh "$ROOT/out/$VSIX_NAME"
