#!/usr/bin/env python3
"""Update CHANGELOG.md for a version release.

Usage: python3 update_changelog.py <NEW_VERSION> <DATE> <OLD_VERSION>

Moves content from [Unreleased] section to a new [X.Y.Z] section.
"""

import re
import sys
from pathlib import Path

def main():
    if len(sys.argv) != 4:
        print(f"Usage: {sys.argv[0]} <NEW_VERSION> <DATE> <OLD_VERSION>")
        sys.exit(1)
    
    new_version = sys.argv[1]
    date_now = sys.argv[2]
    old_version = sys.argv[3]
    
    changelog_path = Path('CHANGELOG.md')
    if not changelog_path.exists():
        print(f"FAIL: {changelog_path} not found")
        sys.exit(1)
    
    lines = changelog_path.read_text().splitlines()
    
    # Find ## [Unreleased] line
    try:
        unreleased_idx = next(i for i, line in enumerate(lines) if line.strip() == '## [Unreleased]')
    except StopIteration:
        print("FAIL: No [Unreleased] section found")
        sys.exit(1)
    
    # Collect unreleased content until next ## [ or end of file
    unreleased_lines = []
    for line in lines[unreleased_idx + 1:]:
        if re.match(r'\s*## \[', line):
            break
        unreleased_lines.append(line)
    
    unreleased_content = '\n'.join(unreleased_lines).strip()
    if not unreleased_content:
        print("FAIL: [Unreleased] section is empty")
        sys.exit(1)
    
    # Build new version section
    new_section_lines = [
        f"## [{new_version}] — {date_now}",
        "",
        unreleased_content,
        "",
        "## [Unreleased]",
        "",
    ]
    
    # Replace the [Unreleased] section in-place
    new_lines = (
        lines[:unreleased_idx]
        + new_section_lines
        + lines[unreleased_idx + 1 + len(unreleased_lines):]
    )
    
    changelog_path.write_text('\n'.join(new_lines) + '\n')
    print(f"PASS: Created [{new_version}] section with unreleased content")

if __name__ == '__main__':
    main()
