#!/usr/bin/env bash
# preflight.sh — Pike Language Server pre-flight test suite
# Usage: bash .omp/skills/cut-release/scripts/preflight.sh [--skip-e2e]
#
# Runs the full test suite before a release. Fails fast on the first error.
# Exit code: 0 = all pass, 1 = one or more failures.
#
# Steps:
#   1. bun run typecheck — TypeScript compiles cleanly
#   2. bun run build:extension — Extension bundles build
#   3. bun test — In-process Bun tests
#   4. bun run test:pike — Pike runtime tests (via pmp)
#   5. bun run test:harness — Harness tests
#   6. bun run test:e2e — E2E tests (VSCode extension host, slow)
#
# The --skip-e2e flag omits step 6. Use it when @vscode/test-electron
# is not installed — CI does not run these tests.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$(dirname "$(dirname "$(dirname "$SCRIPT_DIR")")")")"

# Add pmp to PATH (installed by CI to ~/.pmp/bin)
export PATH="$HOME/.pmp/bin:$PATH"

SKIP_E2E=false
if [[ "$*" == *"--skip-e2e"* ]]; then
  SKIP_E2E=true
fi

cd "$ROOT"

# ── Helpers ───────────────────────────────────────────────────────────────────

PASS_COUNT=0
FAIL_COUNT=0
FAILED_STEPS=()

step() {
  local label="$1"
  local cmd="$2"
  printf "%-40s " "$label..."
  if eval "$cmd" > /dev/null 2>&1; then
    echo "[PASS]"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "[FAIL]"
    echo ""
    echo "  Command: $cmd"
    echo "  Output:"
    eval "$cmd" 2>&1 | sed 's/^/    /'
    echo ""
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_STEPS+=("$label")
    return 1
  fi
}

summary() {
  echo ""
  echo "═══════════════════════════════════════════════════════════════════"
  if [[ $FAIL_COUNT -eq 0 ]]; then
    echo "  Pre-flight checks: ALL PASSED ($PASS_COUNT/$PASS_COUNT)"
  else
    echo "  Pre-flight checks: FAILED ($PASS_COUNT passed, $FAIL_COUNT failed)"
    echo ""
    echo "  Failed steps:"
    for s in "${FAILED_STEPS[@]}"; do
      echo "    - $s"
    done
  fi
  echo "═══════════════════════════════════════════════════════════════════"
  echo ""
}

trap 'summary; exit 1' INT

# ── Run checks (fail fast on first error) ──────────────────────────────────────

echo "Running pre-flight checks..."
echo ""

# 1. TypeScript type-check
if ! step "1. bun run typecheck" "bun run typecheck"; then
  summary
  exit 1
fi

# 2. Build extension
if ! step "2. bun run build:extension" "bun run build:extension"; then
  summary
  exit 1
fi

# 3. In-process Bun tests
if ! step "3. bun test" "bun test"; then
  summary
  exit 1
fi

# 4. Pike runtime tests (via pmp — module resolution handled automatically)
if ! step "4. bun run test:pike" "bun run test:pike"; then
  summary
  exit 1
fi

# 5. Harness tests (warnings go to stderr, suppress them for pass/fail)
if ! step "5. bun run test:harness" "bun run test:harness 2>/dev/null"; then
  summary
  exit 1
fi

# 6. E2E tests (optional — CI does not run these)
if [[ "$SKIP_E2E" == "true" ]]; then
  echo "6. bun run test:e2e ........................ [SKIP --skip-e2e]"
else
  if ! step "6. bun run test:e2e" "bun run test:e2e"; then
    summary
    exit 1
  fi
fi

echo ""
summary
exit 0
