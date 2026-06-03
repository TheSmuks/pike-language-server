#!/usr/bin/env bash
set -euo pipefail

base_ref="${1:-origin/main}"
release_ref="${2:-HEAD}"

git fetch --tags --prune --quiet origin main

main_ref="origin/main"
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
