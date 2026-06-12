#!/usr/bin/env bash
# quality-gates.sh — Run pre-commit quality gate checks
#
# Source of truth: the project-local vendored detector at
# .omp/skills/quality-gates/scripts/detect.sh is authoritative for this repository
# and CI. The Hermes pike-lsp-quality-gates skill is the upstream copy for agents;
# whenever thresholds or heuristics change, update both copies in the same change
# and verify with:
#   diff -u ~/.hermes/skills/pike-lsp/pike-lsp-quality-gates/scripts/detect.sh .omp/skills/quality-gates/scripts/detect.sh
#
# Usage: bash scripts/quality-gates.sh [--all|--functions|--nonnull|--catch|--roottext|--unbounded|--importmeta|--filelen|--nesting|--exports|--loops|--markers|--skips|--catalog]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${0}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Try project-local skill, then Hermes global skill
if [ -f "$PROJECT_ROOT/.omp/skills/quality-gates/scripts/detect.sh" ]; then
  exec bash "$PROJECT_ROOT/.omp/skills/quality-gates/scripts/detect.sh" "$@"
elif [ -f "$HOME/.hermes/skills/pike-lsp/pike-lsp-quality-gates/scripts/detect.sh" ]; then
  cd "$PROJECT_ROOT"
  exec bash "$HOME/.hermes/skills/pike-lsp/pike-lsp-quality-gates/scripts/detect.sh" "$@"
else
  echo "quality-gates detect.sh not found" >&2
  exit 1
fi
