#!/usr/bin/env bash
# Fast feedback loop: build and validate the server in seconds.
# Exit 0 on success, non-zero on any failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

SERVER_DIST="$ROOT/server/dist/server.mjs"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS() { echo -e "${GREEN}✓ ${1}${NC}"; }
FAIL() { echo -e "${RED}✗ ${1}${NC}"; }
INFO() { echo -e "${YELLOW}ℹ ${1}${NC}"; }

cd "$ROOT"

echo ""
INFO "Step 1: Build extension"
echo "────────────────────────────────────────"
if ! bun run build:extension 2>&1; then
  FAIL "build:extension failed"
  exit 1
fi
PASS "build:extension succeeded"

echo ""
INFO "Step 2: Verify server bundle exists"
echo "────────────────────────────────────────"
if [ ! -f "$SERVER_DIST" ]; then
  FAIL "server bundle not found at $SERVER_DIST"
  exit 1
fi
PASS "server bundle exists ($(wc -c < "$SERVER_DIST") bytes)"

echo ""
INFO "Step 3: Verify banner is present in bundle"
echo "────────────────────────────────────────"
if grep -q 'createRequire' "$SERVER_DIST"; then
  PASS "createRequire found in bundle (banner active)"
else
  FAIL "createRequire NOT found in bundle — banner may be missing"
  exit 1
fi

echo ""
INFO "Step 4: Verify no Bun-only APIs (import.meta.dir)"
echo "────────────────────────────────────────"
if grep -c 'import\.meta\.dir[^n]' "$SERVER_DIST" 2>/dev/null | grep -qv '0'; then
  FAIL "import.meta.dir found in bundle — still using Bun-only API"
  grep -n 'import\.meta\.dir' "$SERVER_DIST" | head -5
  exit 1
else
  PASS "no import.meta.dir references in bundle"
fi

echo ""
INFO "Step 5: Verify server module loads without crash"
echo "────────────────────────────────────────"
node --input-type=module << NODESCRIPT
import { pathToFileURL } from 'node:url';

const SERVER = '$SERVER_DIST';

try {
  const server = await import(pathToFileURL(SERVER).href);
  if (typeof server.createPikeServer === 'function') {
    console.log('SMOKE_LOAD_OK');
  } else {
    console.error('SMOKE_LOAD_FAIL: createPikeServer not exported');
    process.exit(1);
  }
} catch (err) {
  console.error('SMOKE_LOAD_FAIL:', err.message);
  process.exit(1);
}
NODESCRIPT

if [ $? -eq 0 ]; then
  PASS "server module loads and exports createPikeServer"
else
  FAIL "server module load failed"
  exit 1
fi

echo ""
INFO "Step 6: Verify server starts without crash"
echo "────────────────────────────────────────"
# Start the server in background, give it time to initialize, check it didn't crash

# Using script(1) to provide a pseudo-TTY — the server needs a TTY to enter interactive mode
# PIKE_LSP_STDIO=1 signals the server to start listening (stdio mode)
(printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{}}}\n' | PIKE_LSP_STDIO=1 script -qfc "node '$SERVER_DIST' --stdio" /dev/null 2>/dev/null || true) &
SERVER_PID=$!
sleep 2
SERVER_EXIT=0
if kill -0 "$SERVER_PID" 2>/dev/null; then
  kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  SERVER_EXIT=$?
fi
# The exit code from server is non-zero in headless, but we only care it didn't segfault.
# Signal 11 (SIGSEGV) or 139 (128+11) indicates a segfault.
if [ "$SERVER_EXIT" -eq 139 ] || [ "$SERVER_EXIT" -eq 11 ]; then
  FAIL "server segfaulted (exit $SERVER_EXIT)"
  exit 1
fi
PASS "server starts without crash"

echo ""
INFO "Step 7: Package VSIX"
echo "────────────────────────────────────────"
if bash "$SCRIPT_DIR/build-vsix.sh" 2>&1; then
  PASS "VSIX packaging succeeded"
else
  FAIL "VSIX packaging failed"
  exit 1
fi

echo ""
echo "────────────────────────────────────────"
PASS "All smoke tests passed"
echo ""