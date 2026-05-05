#!/usr/bin/env bash
# release.sh — Pike Language Server release script
# Usage: bash scripts/release.sh <OLD_VERSION> <NEW_VERSION> [--dry-run]
#
# Updates all 9 version manifest files and builds a VSIX.
#
# Version manifest (9 files):
#   1. .template-version            — whole file content
#   2. CHANGELOG.md                — ## [Unreleased] → ## [X.Y.Z] — DATE
#   3. AGENTS.md                   — version **X.Y.Z**
#   4. README.md                   — template-vX.Y.Z in badge
#   5. .omp/skills/template-guide/SKILL.md  — template-version: X.Y.Z
#   6. .omp/skills/template-guide/scripts/audit.sh — TEMPLATE_VERSION=X.Y.Z
#   7. extension.package.json      — "version": "X.Y.Z"
#   8. package.json               — "version": "X.Y.Z"
#   9. .omp/skills/cut-release/SKILL.md  — version in example commands

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
CHANGELOG_SCRIPT="$ROOT/.omp/skills/cut-release/scripts/update_changelog.py"

# ── Parse args ──────────────────────────────────────────────────────────────

DRY_RUN=false
if [[ "$*" == *"--dry-run"* ]]; then
  echo "DRY RUN — no files will be modified"
  echo ""
  DRY_RUN=true
  # Remove --dry-run from args (strip it and squeeze spaces)
  set -- $(echo "$@" | sed 's/--dry-run//g' | tr -s ' ')
fi

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 [--dry-run] <OLD_VERSION> <NEW_VERSION>"
  echo "Example: $0 0.3.2-beta 0.3.3-beta"
  exit 1
fi

OLD_VERSION="$1"
NEW_VERSION="$2"
TODAY="$(date '+%Y-%m-%d')"

# ── Validate new version is valid semver ────────────────────────────────────

if ! echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9]+)?$'; then
  echo "FAIL: New version '$NEW_VERSION' is not valid semver (expected X.Y.Z or X.Y.Z-suffix)"
  exit 1
fi

if [[ "$OLD_VERSION" == "$NEW_VERSION" ]]; then
  echo "FAIL: OLD_VERSION and NEW_VERSION are identical ('$OLD_VERSION')"
  exit 1
fi

# ── Helper functions ────────────────────────────────────────────────────────

info()  { echo "[INFO]  $*"; }
pass()  { echo "[PASS]  $*"; }
fail()  { echo "[FAIL]  $*" >&2; exit 1; }

replace() {
  # $1 = file, $2 = old pattern, $3 = new text
  local file="$1" old_pat="$2" new_text="$3"
  if [[ "$DRY_RUN" == true ]]; then
    if grep -q "$old_pat" "$file" 2>/dev/null; then
      echo "  Would replace '$old_pat' with '$new_text' in $file"
    else
      echo "  Pattern '$old_pat' NOT FOUND in $file"
    fi
  else
    if grep -q "$old_pat" "$file" 2>/dev/null; then
      sed -i "s/$old_pat/$new_text/g" "$file"
      pass "Updated $file"
    else
      fail "Pattern '$old_pat' not found in $file"
    fi
  fi
}

write_whole() {
  # $1 = file path, $2 = new content
  local file="$1" content="$2"
  if [[ "$DRY_RUN" == true ]]; then
    echo "  Would write '$content' to $file"
  else
    echo -n "$content" > "$file"
    pass "Wrote $file"
  fi
}

# ── Pre-flight: verify OLD_VERSION in all manifest files ─────────────────

info "Pre-flight: checking OLD_VERSION '$OLD_VERSION' in all manifest files..."
ERRORS=0

check_file() {
  local file="$1" label="$2"
  if [[ ! -f "$file" ]]; then
    echo "[PRE ] $file (expected: $label) — MISSING" >&2
    ERRORS=$((ERRORS + 1))
  elif ! grep -q "$OLD_VERSION" "$file" 2>/dev/null; then
    echo "[PRE ] $file (expected: $label) — OLD_VERSION not found" >&2
    ERRORS=$((ERRORS + 1))
  fi
}

check_file "$ROOT/.template-version"                          "1/9 .template-version (whole file)"
check_file "$ROOT/CHANGELOG.md"                               "2/9 CHANGELOG.md"
check_file "$ROOT/AGENTS.md"                                  "3/9 AGENTS.md"
check_file "$ROOT/README.md"                                  "4/9 README.md"
check_file "$ROOT/.omp/skills/template-guide/SKILL.md"        "5/9 template-guide SKILL.md"
check_file "$ROOT/.omp/skills/template-guide/scripts/audit.sh" "6/9 audit.sh"
check_file "$ROOT/extension.package.json"                     "7/9 extension.package.json"
check_file "$ROOT/package.json"                               "8/9 package.json"

# cut-release SKILL.md: only check if it references the actual project version
# (it contains generic template examples, not Pike LS versions)
if grep -q "$OLD_VERSION" "$ROOT/.omp/skills/cut-release/SKILL.md" 2>/dev/null; then
  check_file "$ROOT/.omp/skills/cut-release/SKILL.md"  "9/9 cut-release SKILL.md"
fi

if [[ $ERRORS -gt 0 ]]; then
  fail "Pre-flight failed: $ERRORS manifest file(s) missing OLD_VERSION '$OLD_VERSION'"
fi
pass "Pre-flight passed"

if [[ "$DRY_RUN" == true ]]; then
  echo ""
  echo "  Files to update:"
  echo "    1/9 .template-version"
  echo "    2/9 CHANGELOG.md"
  echo "    3/9 AGENTS.md"
  echo "    4/9 README.md"
  echo "    5/9 .omp/skills/template-guide/SKILL.md"
  echo "    6/9 .omp/skills/template-guide/scripts/audit.sh"
  echo "    7/9 extension.package.json"
  echo "    8/9 package.json"
  if grep -q "$OLD_VERSION" "$ROOT/.omp/skills/cut-release/SKILL.md" 2>/dev/null; then
    echo "    9/9 .omp/skills/cut-release/SKILL.md"
  fi
  echo ""
  info "Dry run complete — no files modified"
  exit 0
fi

# ── Update all 9 files ──────────────────────────────────────────────────────
info "Updating version: $OLD_VERSION → $NEW_VERSION"
echo ""

# Escape old version for sed (handle regex special chars like + in 0.3.2-beta)
OLD_ESCAPED="$(printf '%s' "$OLD_VERSION" | sed 's/[][\.*^$/+?&]/\\&/g')"
NEW_ESCAPED="$(printf '%s' "$NEW_VERSION" | sed 's/[][\.*^$/+?&]/\\&/g')"

# 1/9 .template-version — whole file
write_whole "$ROOT/.template-version" "$NEW_VERSION"

# 2/9 CHANGELOG.md — uses update_changelog.py
info "Updating CHANGELOG.md via update_changelog.py..."
if ! python3 "$CHANGELOG_SCRIPT" "$NEW_VERSION" "$TODAY" "$OLD_VERSION"; then
  fail "update_changelog.py failed"
fi
pass "CHANGELOG.md updated"

# 3/9 AGENTS.md — "version **X.Y.Z**"
replace "$ROOT/AGENTS.md" "version \*\*${OLD_ESCAPED}\*\*" "version **${NEW_ESCAPED}**"

# 4/9 README.md — template-vX.Y.Z in badge
replace "$ROOT/README.md" "template-v${OLD_ESCAPED}" "template-v${NEW_ESCAPED}"

# 5/9 template-guide SKILL.md — "template-version: X.Y.Z"
replace "$ROOT/.omp/skills/template-guide/SKILL.md" "template-version: ${OLD_ESCAPED}" "template-version: ${NEW_ESCAPED}"

# 6/9 audit.sh — TEMPLATE_VERSION=X.Y.Z
replace "$ROOT/.omp/skills/template-guide/scripts/audit.sh" "TEMPLATE_VERSION=${OLD_ESCAPED}" "TEMPLATE_VERSION=${NEW_ESCAPED}"

# 7/9 extension.package.json — "version": "X.Y.Z"
replace "$ROOT/extension.package.json" "\"version\": \"${OLD_ESCAPED}\"" "\"version\": \"${NEW_ESCAPED}\""

# 8/9 package.json — "version": "X.Y.Z"
replace "$ROOT/package.json" "\"version\": \"${OLD_ESCAPED}\"" "\"version\": \"${NEW_ESCAPED}\""

# 9/9 cut-release SKILL.md — version in example commands
# Only update if OLD_VERSION is actually present (avoids replacing generic template examples)
if grep -q "$OLD_VERSION" "$ROOT/.omp/skills/cut-release/SKILL.md" 2>/dev/null; then
  replace "$ROOT/.omp/skills/cut-release/SKILL.md" "${OLD_ESCAPED}" "${NEW_ESCAPED}"
else
  echo "[SKIP] cut-release SKILL.md — does not reference OLD_VERSION (generic examples only)"
fi

# ── Post-flight: verify NEW_VERSION everywhere ─────────────────────────────

echo ""
info "Post-flight: verifying NEW_VERSION '$NEW_VERSION' in all manifest files..."
ERRORS=0


verify_file() {
  local file="$1" label="$2"
  local old_present=false new_present=false stale=false

  if [[ ! -f "$file" ]]; then
    echo "[POST] $file (expected: $label) — MISSING" >&2
    ERRORS=$((ERRORS + 1))
    return
  fi

  # Check for NEW_VERSION
  if grep -q "$NEW_VERSION" "$file" 2>/dev/null; then
    new_present=true
  fi

  # Check for OLD_VERSION
  if grep -q "$OLD_VERSION" "$file" 2>/dev/null; then
    old_present=true
  fi

  if [[ "$new_present" == "false" ]]; then
    echo "[POST] $file (expected: $label) — NEW_VERSION not found" >&2
    ERRORS=$((ERRORS + 1))
  fi

  # Strict stale check: only for files where OLD_VERSION appears in an active
  # version reference, not in comments or previous release headers.
  if [[ "$old_present" == "true" ]]; then
    case "$file" in
      *.json)
        stale_pat="\"version\": \"${OLD_VERSION}\""
        ;;
      */audit.sh)
        stale_pat="TEMPLATE_VERSION=${OLD_VERSION}"
        ;;
      */AGENTS.md)
        stale_pat="version \*\*${OLD_VERSION}\*\*"
        ;;
      */README.md)
        stale_pat="template-v${OLD_VERSION}"
        ;;
      */template-guide/SKILL.md)
        stale_pat="template-version: ${OLD_VERSION}"
        ;;
      */.template-version)
        stale_pat="${OLD_VERSION}"
        ;;
      *)
        stale=false
        ;;
    esac

    if [[ "$stale" != "false" && -n "$stale_pat" ]] && grep -q "$stale_pat" "$file" 2>/dev/null; then
      echo "[POST] $file (expected: $label) — OLD_VERSION still present" >&2
      ERRORS=$((ERRORS + 1))
    fi
  fi
}
verify_file "$ROOT/.template-version"                          "1/9 .template-version"
verify_file "$ROOT/CHANGELOG.md"                              "2/9 CHANGELOG.md"

# cut-release SKILL.md: only verify if it references the actual project version
if grep -q "$OLD_VERSION\|$NEW_VERSION" "$ROOT/.omp/skills/cut-release/SKILL.md" 2>/dev/null; then
  verify_file "$ROOT/.omp/skills/cut-release/SKILL.md" "9/9 cut-release SKILL.md"
fi
verify_file "$ROOT/AGENTS.md"                                  "3/9 AGENTS.md"
verify_file "$ROOT/README.md"                                  "4/9 README.md"
verify_file "$ROOT/.omp/skills/template-guide/SKILL.md"        "5/9 template-guide SKILL.md"
verify_file "$ROOT/.omp/skills/template-guide/scripts/audit.sh" "6/9 audit.sh"
verify_file "$ROOT/extension.package.json"                     "7/9 extension.package.json"
verify_file "$ROOT/package.json"                               "8/9 package.json"

if [[ $ERRORS -gt 0 ]]; then
  fail "Post-flight failed: $ERRORS manifest file(s) missing NEW_VERSION '$NEW_VERSION'"
fi
pass "Post-flight passed"

# ── Build VSIX ─────────────────────────────────────────────────────────────

echo ""
info "Building VSIX..."
echo ""

cd "$ROOT"
if ! bash "$ROOT/scripts/build-vsix.sh"; then
  fail "VSIX build failed"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════════"
info "Release v$NEW_VERSION complete!"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Review changes:    git diff"
echo "  2. Commit:            git add -A && git commit -m \"chore: cut v$NEW_VERSION\""
echo "  3. Push:              git push -u origin HEAD"
echo "  4. Create PR:         gh pr create --base main --title \"chore: cut v$NEW_VERSION\""
echo "  5. Monitor CI and merge"
echo "  6. Tag:               git tag -a v$NEW_VERSION -m \"Release v$NEW_VERSION\""
echo "  7. Push tag:          git push origin v$NEW_VERSION"
echo "  8. Create release:    gh release create v$NEW_VERSION --title \"v$NEW_VERSION\" \\"
echo "                         --notes-file CHANGELOG.md"
echo ""
echo "VSIX: pike-language-server-$NEW_VERSION.vsix"
