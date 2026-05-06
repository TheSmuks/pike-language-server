#!/usr/bin/env bash
# VSCode Extension Test Lab - Run integration tests headlessly
# Usage: bash scripts/test-vscode.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

echo "=== VSCode Extension Test Lab ==="
echo ""

# Step 1: Build extension
echo "Step 1: Building extension..."
if ! bun run build:extension 2>&1; then
    echo "FAILED: Extension build failed"
    exit 1
fi
echo "✓ Extension built"
echo ""

# Step 2: Compile integration tests
echo "Step 2: Compiling integration tests..."
cd "$ROOT/tests/integration"
rm -rf dist
if ! npx tsc 2>&1; then
    echo "FAILED: TypeScript compilation failed"
    exit 1
fi

# Rename .js to .cjs for CommonJS explicit format
find dist -name "*.js" -exec sh -c 'mv "$0" "${0%.js}.cjs"' {} \; 2>/dev/null || true
echo "✓ Tests compiled to CommonJS format"
echo ""

# Step 3: Run integration tests with xvfb
echo "Step 3: Running integration tests with xvfb-run..."
cd "$ROOT"
xvfb-run -a bun run test:integration 2>&1 || {
    echo "FAILED: Integration tests failed"
    exit 1
}

echo ""
echo "=== All tests passed ==="