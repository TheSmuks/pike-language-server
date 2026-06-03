#!/usr/bin/env bash
set -euo pipefail

declare -A seen=()
status=0

while IFS= read -r -d '' file; do
  base=$(basename "$file")
  prefix=${base%%-*}
  if [[ ! $prefix =~ ^[0-9]{4}$ ]]; then
    continue
  fi
  if [[ -n ${seen[$prefix]:-} ]]; then
    echo "duplicate ADR prefix $prefix:" >&2
    echo "  ${seen[$prefix]}" >&2
    echo "  $file" >&2
    status=1
  else
    seen[$prefix]="$file"
  fi
done < <(find decisions -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]-*.md' -print0)

if [[ $status -eq 0 ]]; then
  echo "ADR prefixes unique (${#seen[@]} files)"
fi

exit "$status"
