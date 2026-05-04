#!/usr/bin/env node
/**
 * Validate CHANGELOG.md structure.
 *
 * Only validates the [Unreleased] section:
 * - No orphan sections (### Added, ### Changed etc. under wrong ## version)
 * - Sections appear in correct order: Added, Changed, Deprecated, Removed, Fixed, Security
 * - No empty sections
 *
 * Historical version sections are not validated — they are frozen records.
 */

import { readFileSync } from "node:fs";

const CHANGELOG_PATH = process.argv[2] ?? "CHANGELOG.md";

const EXPECTED_SECTION_ORDER = [
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
];

const VERSION_HEADER = /^##\s+\[([^\]]+)\]/;
const SECTION_HEADER = /^###\s+(\w+)/;
const EMPTY_LINE = /^(?:[#]|$)/;

const content = readFileSync(CHANGELOG_PATH, "utf8");
const lines = content.split("\n");

let errors = [];

let currentVersion = null;
let currentSection = null;
let sectionHasContent = false;
let inUnreleased = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const lineNum = i + 1;

  // Track current version
  const versionMatch = line.match(VERSION_HEADER);
  if (versionMatch) {
    currentVersion = versionMatch[1];
    currentSection = null;
    sectionHasContent = false;
    inUnreleased = currentVersion === "Unreleased";
    continue;
  }

  // Skip validation for historical (non-Unreleased) versions
  if (!inUnreleased) continue;

  // Track current section
  const sectionMatch = line.match(SECTION_HEADER);
  if (sectionMatch) {
    const sectionName = sectionMatch[1];

    // Check if previous section was empty
    if (currentSection && !sectionHasContent) {
      errors.push(
        `Line ${lineNum}: Empty section '### ${currentSection}' under '${currentVersion}'`
      );
    }

    // Check section order
    const sectionIndex = EXPECTED_SECTION_ORDER.indexOf(currentSection ?? "");
    const newSectionIndex = EXPECTED_SECTION_ORDER.indexOf(sectionName);
    if (
      currentSection &&
      newSectionIndex !== -1 &&
      sectionIndex !== -1 &&
      newSectionIndex < sectionIndex
    ) {
      errors.push(
        `Line ${lineNum}: Wrong section order. '### ${sectionName}' should come before '### ${currentSection}' under '${currentVersion}'. Expected order: ${EXPECTED_SECTION_ORDER.join(", ")}`
      );
    }

    currentSection = sectionName;
    sectionHasContent = false;
    continue;
  }

  // Non-empty, non-comment line under a section
  if (currentVersion && currentSection && !EMPTY_LINE.test(line.trim())) {
    sectionHasContent = true;
  }
}

// Check final section
if (currentSection && !sectionHasContent && inUnreleased) {
  errors.push(`Final section '### ${currentSection}' under '${currentVersion}' is empty`);
}

if (errors.length > 0) {
  console.error("CHANGELOG.md validation failed:");
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log("CHANGELOG.md validation passed.");
process.exit(0);
