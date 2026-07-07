#!/usr/bin/env bash
#
# bump-version.sh — set the template/release version in every file that records
# it, and roll the CHANGELOG, in one atomic step.
#
# The release version lives in six places that must stay in lock-step:
#   1. .template-version                                  (canonical)
#   2. README.md                                          (<!-- template-vX.Y.Z -->)
#   3. AGENTS.md                                          (version **X.Y.Z**)
#   4. .omp/skills/template-guide/SKILL.md                (template-version: X.Y.Z)
#   5. .omp/skills/template-guide/scripts/audit.sh        (TEMPLATE_VERSION=X.Y.Z)
#   6. CHANGELOG.md                                       ([Unreleased] -> [X.Y.Z])
#
# This script updates all of them so a release cut can't drift. Note: it does
# NOT touch package.json — the extension/VSIX version is intentionally
# decoupled from the template/release version.
#
# Usage:
#   scripts/bump-version.sh <X.Y.Z> [--date YYYY-MM-DD] [--no-changelog]
#
# Options:
#   --date          Date for the CHANGELOG heading (default: today, UTC).
#   --no-changelog  Update the version markers only; leave CHANGELOG.md alone.
#
set -euo pipefail

# --- locate repo root (this script lives in scripts/) --------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- parse args ---------------------------------------------------------------
VERSION=""
DATE="$(date -u +%F)"
ROLL_CHANGELOG=1

while [ $# -gt 0 ]; do
  case "$1" in
    --date)         DATE="${2:?--date needs a value}"; shift 2 ;;
    --no-changelog) ROLL_CHANGELOG=0; shift ;;
    -h|--help)      sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)             echo "error: unknown option '$1'" >&2; exit 2 ;;
    *)              if [ -z "$VERSION" ]; then VERSION="$1"; else echo "error: unexpected arg '$1'" >&2; exit 2; fi; shift ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "error: version argument required (X.Y.Z)" >&2
  echo "usage: scripts/bump-version.sh <X.Y.Z> [--date YYYY-MM-DD] [--no-changelog]" >&2
  exit 2
fi
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "error: version '$VERSION' is not X.Y.Z" >&2
  exit 2
fi

cd "$ROOT"

OLD_VERSION="$(cat .template-version 2>/dev/null || echo '?')"
echo "Bumping template version: $OLD_VERSION -> $VERSION"

# --- helper: sed -i in place, and assert the pattern matched something --------
# replace_in <file> <sed-expr> <human-label> <grep-pattern-that-must-exist>
replace_in() {
  local file="$1" expr="$2" label="$3"
  [ -f "$file" ] || { echo "error: $file not found" >&2; exit 1; }
  if ! grep -Eq "$4" "$file"; then
    echo "error: $label marker not found in $file (format changed?)" >&2
    exit 1
  fi
  sed -i -E "$expr" "$file"
}

# 1. canonical version file
printf '%s\n' "$VERSION" > .template-version

# 2. README badge comment
replace_in README.md \
  "s/template-v[0-9]+\.[0-9]+\.[0-9]+/template-v$VERSION/g" \
  "README template badge" \
  'template-v[0-9]+\.[0-9]+\.[0-9]+'

# 3. AGENTS.md generated-from line
replace_in AGENTS.md \
  "s/version \*\*[0-9]+\.[0-9]+\.[0-9]+\*\*/version **$VERSION**/g" \
  "AGENTS.md version" \
  'version \*\*[0-9]+\.[0-9]+\.[0-9]+\*\*'

# 4. template-guide SKILL front matter
replace_in .omp/skills/template-guide/SKILL.md \
  "s/^template-version: .*/template-version: $VERSION/" \
  "SKILL template-version" \
  '^template-version: '

# 5. audit.sh constant
replace_in .omp/skills/template-guide/scripts/audit.sh \
  "s/^TEMPLATE_VERSION=.*/TEMPLATE_VERSION=$VERSION/" \
  "audit.sh TEMPLATE_VERSION" \
  '^TEMPLATE_VERSION='

# 6. CHANGELOG roll: insert a new version heading under [Unreleased], keeping
#    [Unreleased] on top (Keep-a-Changelog order).
if [ "$ROLL_CHANGELOG" -eq 1 ]; then
  [ -f CHANGELOG.md ] || { echo "error: CHANGELOG.md not found" >&2; exit 1; }
  if ! grep -q '^## \[Unreleased\]' CHANGELOG.md; then
    echo "error: '## [Unreleased]' heading not found in CHANGELOG.md" >&2
    exit 1
  fi
  if grep -q "^## \[$VERSION\]" CHANGELOG.md; then
    echo "error: CHANGELOG.md already has a [$VERSION] section" >&2
    exit 1
  fi
  awk -v ver="$VERSION" -v date="$DATE" '
    { print }
    !done && /^## \[Unreleased\]/ {
      print ""
      print "## [" ver "] — " date
      done = 1
    }
  ' CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md
fi

echo "Updated:"
echo "  .template-version"
echo "  README.md"
echo "  AGENTS.md"
echo "  .omp/skills/template-guide/SKILL.md"
echo "  .omp/skills/template-guide/scripts/audit.sh"
[ "$ROLL_CHANGELOG" -eq 1 ] && echo "  CHANGELOG.md  ([Unreleased] -> [$VERSION] — $DATE)"
echo "Done. Review the diff, then commit as 'chore: cut v$VERSION'."
