#!/usr/bin/env bash
# test-pike.sh — Run the PUnit test suite for Pike Language Server
#
# Usage:
#   scripts/test-pike.sh              # run all Pike tests
#   scripts/test-pike.sh -v           # verbose output
#   scripts/test-pike.sh tests/pike/DefinitionTests.pike  # single file
#
# Exits 0 on all-pass, 1 on any failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default test directory
TEST_DIR="${1:-tests/pike}"
VERBOSE=""

# Handle -v flag
if [[ "${1:-}" == "-v" || "${1:-}" == "--verbose" ]]; then
  VERBOSE="1"
  TEST_DIR="${2:-tests/pike}"
fi

cd "$PROJECT_ROOT"

# Verify Pike is available
if ! command -v pike &>/dev/null; then
  echo "[ERROR] pike not found on PATH. Install Pike 8.0+ and ensure 'pike' is available."
  exit 1
fi

# Verify PUnit module exists
if [[ ! -d "modules/PUnit.pmod" ]]; then
  echo "[ERROR] PUnit module not found at modules/PUnit.pmod"
  echo "        Run the test bootstrap setup first."
  exit 1
fi

echo "[INFO] Running Pike test suite from $TEST_DIR"
echo "[INFO] Pike version: $(pike --version 2>&1 | head -1)"

# Run the PUnit test runner
# Module paths:
#   -M modules       — PUnit framework
#   -M harness       — Common.pike helpers (DiagnosticHandler, normalize_diagnostics)
#   -M tests/pike    — Shared test helpers (LspProtocol.pmod, TestBootstrap.pmod)
exec pike -M modules -M harness -M tests/pike tests/pike/run_tests.pike "$TEST_DIR"
