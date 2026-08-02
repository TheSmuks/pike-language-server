#!/usr/bin/env bash
set -euo pipefail

base_ref="${1:-origin/main}"
release_ref="${2:-HEAD}"

# Fetch whatever base_ref actually names, not a hardcoded "origin main" — the
# fetch used to run unconditionally regardless of the argument, so a caller
# passing a different remote-tracking ref (e.g. origin/release-1.x) still
# only got origin/main refreshed locally, and the merge-base/tree checks
# below would fail on that other ref with "not a valid object name" even
# when it legitimately existed on the remote.
fetch_remote="origin"
fetch_branch="main"
if [[ "$base_ref" == */* ]]; then
  fetch_remote="${base_ref%%/*}"
  fetch_branch="${base_ref#*/}"
fi
git fetch --tags --prune --quiet "$fetch_remote" "$fetch_branch"

main_ref="$base_ref"
if ! git merge-base --is-ancestor "$release_ref" "$main_ref"; then
  echo "release ref $release_ref is not an ancestor of $main_ref" >&2
  exit 1
fi

release_tree=$(git rev-parse "$release_ref^{tree}")
main_tree=$(git rev-parse "$main_ref^{tree}")
if [ "$release_tree" != "$main_tree" ]; then
  echo "release ref $release_ref tree does not match $main_ref" >&2
  echo "release tree: $release_tree" >&2
  echo "main tree:    $main_tree" >&2
  exit 1
fi

echo "release lineage ok: $release_ref is ancestor-or-equal of $main_ref and trees match"
