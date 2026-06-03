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

# Step 2: Install and compile integration tests
echo "Step 2: Installing and compiling integration tests..."
cd "$ROOT/tests/integration"
if ! bun install --frozen-lockfile 2>&1; then
    echo "FAILED: Integration dependency install failed"
    exit 1
fi
rm -rf dist
if ! bun run compile 2>&1; then
    echo "FAILED: TypeScript compilation failed"
    exit 1
fi
echo "✓ Tests compiled"
echo ""

# Step 3: Run integration tests with xvfb
echo "Step 3: Running integration tests with xvfb-run..."
cd "$ROOT"
bun run test:integration 2>&1 || {
    echo "FAILED: Integration tests failed"
    exit 1
}

echo ""
echo "=== All tests passed ==="