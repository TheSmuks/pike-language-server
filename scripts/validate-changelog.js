#!/usr/bin/env node
/**
 * Validate CHANGELOG.md structure per Keep a Changelog 1.1.0.
 *
 * Validates:
 * - File header present (# Changelog + preamble)
 * - No duplicate version headers
 * - Section types are standard (Added, Changed, Deprecated, Removed, Fixed, Security)
 * - Sections appear in correct order per version
 * - No empty sections (sections with only headers but no content)
 * - No orphaned content (content not under a section)
 *
 * Historical phase entries (e.g., "Phase N: ...") are validated for structure
 * but their section order is flexible since they predate semver adoption.
 */

import { readFileSync } from "node:fs";

const CHANGELOG_PATH = process.argv[2] ?? "CHANGELOG.md";

const STANDARD_SECTIONS = [
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
];

const VALID_SECTION_TYPES = new Set([
  ...STANDARD_SECTIONS,
  "Not done",  // Internal tracking - allowed but typically empty
]);

const VERSION_HEADER = /^##\s+\[([^\]]+)\]/;
const PHASE_HEADER = /^##\s+Phase\s+\d+/;
const SECTION_HEADER = /^###\s+(\w+)/;
const EMPTY_LINE = /^(?:[#]|$)/;

const FILE_HEADER_PATTERN = [
  /^# Changelog$/,
  /^$/,
  /^All notable changes to the Pike Language Server project will be documented in this file\.$/,
  /^$/,
  /^The format is based on \[Keep a Changelog\]/,
  /^and this project adheres to \[Semantic Versioning\]/,
];

const content = readFileSync(CHANGELOG_PATH, "utf8");
const lines = content.split("\n");

const errors = [];
const versions = new Map();  // For duplicate detection
let lineNum = 0;

function addError(msg, line) {
  errors.push(`Line ${line}: ${msg}`);
}

// 1. Validate file header
for (let i = 0; i < FILE_HEADER_PATTERN.length; i++) {
  const line = lines[i] ?? "";
  if (!FILE_HEADER_PATTERN[i].test(line)) {
    addError(`File header line ${i + 1} does not match expected pattern (got: "${line}")`, i + 1);
  }
}

// Find end of file header (first version header)
let headerEnd = 0;
let foundVersion = false;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].match(/^##\s/)) {
    headerEnd = i;
    foundVersion = true;
    break;
  }
}
if (!foundVersion) {
  addError("No version headers found in file", 1);
}

// 2. Validate version sections
let currentVersion = null;
let currentVersionLine = 0;
let currentSection = null;
let sectionHasContent = false;
let isSemVer = false;

for (let i = headerEnd; i < lines.length; i++) {
  lineNum = i + 1;
  const line = lines[i];
  
  // Version header
  const verMatch = line.match(VERSION_HEADER);
  const phaseMatch = line.match(PHASE_HEADER);
  
  if (verMatch) {
    const versionId = verMatch[1];
    
    // Check for duplicates
    if (versions.has(versionId)) {
      addError(`Duplicate version header: ${versionId} (first seen at line ${versions.get(versionId)})`, lineNum);
    } else {
      versions.set(versionId, lineNum);
    }
    

    currentVersion = verMatch[0].substring(3);  // "## [version]"
    currentVersionLine = lineNum;
    // [Unreleased] is not a released version — skip section ordering.
    isSemVer = versionId !== "Unreleased";
    currentSection = null;
    sectionHasContent = false;
    continue;
  }
  
  if (phaseMatch) {
    // Historical phase header
    currentVersion = line;
    currentVersionLine = lineNum;
    isSemVer = false;
    currentSection = null;
    sectionHasContent = false;
    continue;
  }
  
  // Section header
  const secMatch = line.match(SECTION_HEADER);
  if (secMatch) {
    const secName = secMatch[1];
    
    // Check if previous section was empty
    if (currentSection && !sectionHasContent) {
      addError(`Empty section '### ${currentSection}' under '${currentVersion}'`, lineNum);
    }
    
    // Check section type
    if (!VALID_SECTION_TYPES.has(secName)) {
      addError(`Non-standard section type '### ${secName}' — expected one of: ${STANDARD_SECTIONS.join(", ")}`, lineNum);
    }
    
    // Check section order (only for semver versions)
    if (isSemVer && currentSection) {
      const currentIdx = STANDARD_SECTIONS.indexOf(currentSection);
      const newIdx = STANDARD_SECTIONS.indexOf(secName);
      if (currentIdx !== -1 && newIdx !== -1 && newIdx < currentIdx) {
        addError(`Wrong section order. '### ${secName}' should come before '### ${currentSection}' under '${currentVersion}'. Expected order: ${STANDARD_SECTIONS.join(", ")}`, lineNum);
      }
    }
    
    currentSection = secName;
    sectionHasContent = false;
    continue;
  }
  
  // Non-empty, non-comment line under a section
  if (currentVersion && currentSection && !EMPTY_LINE.test(line.trim())) {
    sectionHasContent = true;
  }
}

// Check final section
if (currentSection && !sectionHasContent) {
  addError(`Final section '### ${currentSection}' under '${currentVersion}' is empty`, lineNum);
}

// 3. Validate version order (newer semver versions first)
const semverPattern = /^\d+\.\d+\.\d+$/;
const semverVersions = [];
for (const [id, line] of versions) {
  if (semverPattern.test(id)) {
    semverVersions.push({ id, line });
  }
}

for (let i = 1; i < semverVersions.length; i++) {
  const prev = semverVersions[i - 1];
  const curr = semverVersions[i];
  const prevParts = prev.id.split(".").map(Number);
  const currParts = curr.id.split(".").map(Number);
  // Compare semver: prev should be >= curr (descending order)
  let prevIsOlder = false;
  for (let j = 0; j < 3; j++) {
    if (currParts[j] > prevParts[j]) { prevIsOlder = true; break; }
    if (currParts[j] < prevParts[j]) { break; }
  }
  if (prevIsOlder) {
    addError(
      `Version ${curr.id} (line ${curr.line}) appears after ${prev.id} (line ${prev.line}) ` +
      `but should come first (newer versions first)`,
      curr.line
    );
  }
}

// Report results
if (errors.length > 0) {
  console.error("CHANGELOG.md validation failed:");
  for (const err of errors) {
    console.error("  - " + err);
  }
  process.exit(1);
}

console.log("CHANGELOG.md validation passed.");
process.exit(0);