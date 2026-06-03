#!/usr/bin/env bash
# detect.sh — Automated detection of recurring anti-patterns from 3 audit iterations
# Usage:
#   bash detect.sh              # run all checks (except golden test)
#   bash detect.sh --all        # same as above
#   bash detect.sh --functions  # TigerStyle function length (Python-based)
#   bash detect.sh --nonnull    # Non-null assertions on tree-sitter nodes
#   bash detect.sh --catch      # Silent catch blocks
#   bash detect.sh --roottext   # rootNode.text materialization
#   bash detect.sh --unbounded  # Unbounded Map/Set without eviction
#   bash detect.sh --importmeta # import.meta.dirname! assertions
#   bash detect.sh --filelen    # TigerStyle file length

set -euo pipefail

PROJECT_ROOT="$(pwd)"
if [ ! -f "${PROJECT_ROOT}/AGENTS.md" ]; then
  echo "Run this script from the project root directory." >&2
  exit 1
fi

ERRORS=0
WARNINGS=0

fail() { echo "[FAIL] $*" >&2; ERRORS=$((ERRORS + 1)); }
warn() { echo "[WARN] $*" >&2; WARNINGS=$((WARNINGS + 1)); }

# ── Filter: which checks to run ────────────────────────────────────────────

RUN_ALL=false
RUN_FUNCTIONS=false
RUN_NONNULL=false
RUN_CATCH=false
RUN_ROOTTEXT=false
RUN_UNBOUNDED=false
RUN_IMPORTMETA=false
RUN_FILELEN=false

if [ $# -eq 0 ]; then
  RUN_ALL=true
fi

for arg in "$@"; do
  case "$arg" in
    --all)        RUN_ALL=true ;;
    --functions)  RUN_FUNCTIONS=true ;;
    --nonnull)    RUN_NONNULL=true ;;
    --catch)      RUN_CATCH=true ;;
    --roottext)   RUN_ROOTTEXT=true ;;
    --unbounded)  RUN_UNBOUNDED=true ;;
    --importmeta) RUN_IMPORTMETA=true ;;
    --filelen)    RUN_FILELEN=true ;;
    *)
      echo "Unknown flag: $arg" >&2
      echo "Usage: $0 [--all|--functions|--nonnull|--catch|--roottext|--unbounded|--importmeta|--filelen]" >&2
      exit 1
      ;;
  esac
done

if $RUN_ALL; then
  RUN_FUNCTIONS=true
  RUN_NONNULL=true
  RUN_CATCH=true
  RUN_ROOTTEXT=true
  RUN_UNBOUNDED=true
  RUN_IMPORTMETA=true
  RUN_FILELEN=true
fi

# ── 1. Function Length > 50 Lines ──────────────────────────────────────────

if $RUN_FUNCTIONS; then
  echo "=== TigerStyle: Functions over 50 lines ==="

  FUNC_COUNT=0
  while IFS= read -r result; do
    if [ -n "$result" ]; then
      fail "$result"
      FUNC_COUNT=$((FUNC_COUNT + 1))
    fi
  done < <(python3 - "$PROJECT_ROOT" <<'PYEOF'
import sys, os, re

project_root = sys.argv[1]
limit = 55  # 50 + 5 margin for signatures/blank lines

func_re = re.compile(
    r'^\s*(?:export\s+)?(?:async\s+)?(?:function\s+\w+|'
    r'(?:private|public|protected|readonly|static|abstract|override)\s+)+'
    r'(?:async\s+)?(?:get\s+|set\s+)?\w+\s*\('
)
arrow_re = re.compile(r'^\s*(?:export\s+)?const\s+\w+\s*=\s*(?:async\s+)?\(')

def count_function(filepath):
    findings = []
    try:
        with open(filepath, 'r') as f:
            lines = f.readlines()
    except:
        return findings

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.lstrip()
        if stripped.startswith('//') or stripped.startswith('/*') or stripped.startswith('*'):
            i += 1
            continue

        is_func = func_re.match(line) or arrow_re.match(line)
        if not is_func:
            i += 1
            continue

        start = i + 1  # 1-indexed
        depth = 0
        found_open = False
        j = i

        while j < len(lines):
            l = lines[j]
            code = re.sub(r'//.*$', '', l)
            code = re.sub(r'/\*.*?\*/', '', code)
            for ch in code:
                if ch == '{':
                    depth += 1
                    found_open = True
                elif ch == '}':
                    depth -= 1
            if found_open and depth <= 0:
                length = j - i + 1
                if length > limit:
                    relpath = os.path.relpath(filepath, project_root)
                    findings.append(f"{relpath}:{start} — {length} lines")
                break
            j += 1
        i += 1
    return findings

for root, dirs, files in os.walk(os.path.join(project_root, 'server', 'src')):
    dirs[:] = [d for d in dirs if d != 'node_modules']
    for fname in files:
        if fname.endswith('.ts') and not fname.endswith('.d.ts'):
            fpath = os.path.join(root, fname)
            for finding in count_function(fpath):
                print(finding)
PYEOF
  )

  if [ "$FUNC_COUNT" -eq 0 ]; then
    echo "[PASS] All functions under 55 lines"
  fi
fi

# ── 2. Non-Null Assertions on Tree-Sitter Nodes ─────────────────────────────

if $RUN_NONNULL; then
  echo ""
  echo "=== Non-null assertions on tree-sitter/array access ==="

  NONNULL_COUNT=0
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      case "$line" in
        *'// '*|*'/*'*) continue ;;
      esac
      fail "$(echo "$line" | sed "s|${PROJECT_ROOT}/||")"
      NONNULL_COUNT=$((NONNULL_COUNT + 1))
    fi
  done < <(
    grep -rn '\.child([0-9]\+)!' server/src/ --include='*.ts' 2>/dev/null || true
    grep -rn '\.parent!' server/src/ --include='*.ts' 2>/dev/null || true
    grep -rn '\.children!' server/src/ --include='*.ts' 2>/dev/null || true
    grep -rn '\.namedChild([0-9]\+)!' server/src/ --include='*.ts' 2>/dev/null || true
    grep -rn '\.firstChild!' server/src/ --include='*.ts' 2>/dev/null || true
    grep -rn '\.shift()!' server/src/ --include='*.ts' 2>/dev/null || true
    grep -rn '\.pop()!' server/src/ --include='*.ts' 2>/dev/null || true
  )

  if [ "$NONNULL_COUNT" -eq 0 ]; then
    echo "[PASS] No non-null assertions on tree-sitter/array access"
  fi
fi

# ── 3. Silent Catch Blocks ─────────────────────────────────────────────────

if $RUN_CATCH; then
  echo ""
  echo "=== Silent catch blocks ==="

  CATCH_COUNT=0
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      FILE=$(echo "$line" | cut -d: -f1)
      LINENUM=$(echo "$line" | cut -d: -f2)
      NEXT=$(sed -n "$((LINENUM + 1))p" "$FILE" 2>/dev/null || echo "")
      if echo "$NEXT" | grep -qE '//|/\*'; then
        warn "$(echo "$line" | sed "s|${PROJECT_ROOT}/||") (has comment — verify it explains WHY)"
      else
        fail "$(echo "$line" | sed "s|${PROJECT_ROOT}/||")"
        CATCH_COUNT=$((CATCH_COUNT + 1))
      fi
    fi
  done < <(
    grep -rn 'catch\s*()\s*{' server/src/ --include='*.ts' 2>/dev/null || true
    grep -rn 'void err' server/src/ --include='*.ts' 2>/dev/null || true
  )

  if [ "$CATCH_COUNT" -eq 0 ]; then
    echo "[PASS] No silent catch blocks without explanatory comments"
  fi
fi

# ── 4. rootNode.text Materialization ────────────────────────────────────────

if $RUN_ROOTTEXT; then
  echo ""
  echo "=== rootNode.text / root.text materialization ==="

  ROOT_COUNT=0
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      case "$line" in
        *'// '*|*'/*'*) continue ;;
      esac
      fail "$(echo "$line" | sed "s|${PROJECT_ROOT}/||")"
      ROOT_COUNT=$((ROOT_COUNT + 1))
    fi
  done < <(
    grep -rn 'rootNode\.text' server/src/ --include='*.ts' 2>/dev/null || true
    grep -rn 'root\.text' server/src/ --include='*.ts' 2>/dev/null || true
  )

  if [ "$ROOT_COUNT" -eq 0 ]; then
    echo "[PASS] No rootNode.text usage"
  fi
fi

# ── 5. Unbounded Map/Set ───────────────────────────────────────────────────

if $RUN_UNBOUNDED; then
  echo ""
  echo "=== Unbounded Map/Set (no eviction logic in file) ==="

  MAP_COUNT=0
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      FILE=$(echo "$line" | cut -d: -f1)
      if grep -qE '(\.delete\(|\.clear\(|LRU|CACHE_MAX|MAX_ENTRIES|evict|size > |size >=)' "$FILE" 2>/dev/null; then
        : # File has eviction logic — probably OK
      else
        warn "$(echo "$line" | sed "s|${PROJECT_ROOT}/||") (no eviction logic found in file)"
        MAP_COUNT=$((MAP_COUNT + 1))
      fi
    fi
  done < <(
    grep -rn 'new Map<' server/src/ --include='*.ts' 2>/dev/null || true
    grep -rn '= new Map()' server/src/ --include='*.ts' 2>/dev/null || true
  )

  if [ "$MAP_COUNT" -eq 0 ]; then
    echo "[PASS] All Maps/Sets appear to have eviction logic"
  fi
fi

# ── 6. import.meta.dirname! ────────────────────────────────────────────────

if $RUN_IMPORTMETA; then
  echo ""
  echo "=== import.meta non-null assertions ==="

  META_COUNT=0
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      fail "$(echo "$line" | sed "s|${PROJECT_ROOT}/||")"
      META_COUNT=$((META_COUNT + 1))
    fi
  done < <(
    grep -rn 'import\.meta\.dirname!' server/src/ --include='*.ts' 2>/dev/null || true
    grep -rn 'import\.meta\.url!' server/src/ --include='*.ts' 2>/dev/null || true
  )

  if [ "$META_COUNT" -eq 0 ]; then
    echo "[PASS] No import.meta non-null assertions"
  fi
fi

# ── 7. File Length > 500 Lines ─────────────────────────────────────────────

if $RUN_FILELEN; then
  echo ""
  echo "=== TigerStyle: Files over 500 lines ==="

  FILELEN_COUNT=0
  while IFS= read -r result; do
    if [ -n "$result" ]; then
      fail "$result"
      FILELEN_COUNT=$((FILELEN_COUNT + 1))
    fi
  done < <(
    wc -l server/src/features/*.ts server/src/*.ts server/src/util/*.ts 2>/dev/null \
      | awk '$1 > 500 && $2 != "total" { printf "%s — %d lines\n", $2, $1 }'
  )

  if [ "$FILELEN_COUNT" -eq 0 ]; then
    echo "[PASS] All files under 500 lines"
  fi
fi

# ── Summary ─────────────────────────────────────────────────────────────────

echo ""
if [ "$ERRORS" -eq 0 ] && [ "$WARNINGS" -eq 0 ]; then
  echo "=== All checks passed ==="
  exit 0
elif [ "$ERRORS" -eq 0 ]; then
  echo "=== ${WARNINGS} warning(s), 0 failures ==="
  exit 0
else
  echo "=== ${ERRORS} failure(s), ${WARNINGS} warning(s) ==="
  exit 1
fi
