#!/usr/bin/env bash
# quality-gates.sh — Run pre-commit quality gate checks
# Wraps the detect.sh from the pike-lsp-quality-gates skill
# Usage: bash scripts/quality-gates.sh [--all|--functions|--nonnull|--catch|--roottext|--unbounded|--importmeta|--filelen]

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
