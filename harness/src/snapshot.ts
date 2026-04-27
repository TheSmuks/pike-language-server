/**
 * Snapshot read/write/diff for harness test results.
 */

import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import type { IntrospectionResult, Diagnostic, SnapshotDiff } from "./types";
import { SNAPSHOTS_DIR } from "./runner";

// ---------------------------------------------------------------------------
// Normalization — canonical key ordering for stable comparison
// ---------------------------------------------------------------------------

function canonicalizeDiagnostic(d: Diagnostic): Record<string, unknown> {
  // Produce a deterministic key ordering for comparison
  const out: Record<string, unknown> = {
    line: d.line,
    severity: d.severity,
    category: d.category,
    message: d.message,
  };
  if (d.expected_type !== undefined) out.expected_type = d.expected_type;
  if (d.actual_type !== undefined) out.actual_type = d.actual_type;
  return out;
}

function canonicalizeResult(r: IntrospectionResult): Record<string, unknown> {
  return {
    file: r.file,
    pike_version: r.pike_version,
    compilation: {
      exit_code: r.compilation.exit_code,
      strict_types: r.compilation.strict_types,
    },
    diagnostics: r.diagnostics.map(canonicalizeDiagnostic),
    autodoc: r.autodoc,
    error: r.error,
  };
}

function stableStringify(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort());
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

export function readSnapshot(name: string): IntrospectionResult | null {
  const path = join(SNAPSHOTS_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as IntrospectionResult;
}

export function writeSnapshot(name: string, data: IntrospectionResult): void {
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const path = join(SNAPSHOTS_DIR, `${name}.json`);
  // Write with canonical key ordering for readable diffs
  const canonical = canonicalizeResult(data);
  writeFileSync(path, JSON.stringify(canonical, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * Compare two introspection results. Returns null if identical (ignoring
 * `pike_version` which is informational), or an array of field diffs.
 */
export function diffSnapshot(
  actual: IntrospectionResult,
  expected: IntrospectionResult,
): SnapshotDiff[] | null {
  const diffs: SnapshotDiff[] = [];

  // Normalize both sides for comparison
  const canonActual = canonicalizeResult(actual);
  const canonExpected = canonicalizeResult(expected);

  // Compare diagnostics arrays
  const diagActual = JSON.stringify(canonActual.diagnostics);
  const diagExpected = JSON.stringify(canonExpected.diagnostics);
  if (diagActual !== diagExpected) {
    diffs.push({
      field: "diagnostics",
      expected: canonExpected.diagnostics,
      actual: canonActual.diagnostics,
    });
  }

  // Compare compilation
  const compActual = JSON.stringify(canonActual.compilation);
  const compExpected = JSON.stringify(canonExpected.compilation);
  if (compActual !== compExpected) {
    diffs.push({
      field: "compilation",
      expected: canonExpected.compilation,
      actual: canonActual.compilation,
    });
  }

  // Compare autodoc
  if (canonActual.autodoc !== canonExpected.autodoc) {
    diffs.push({
      field: "autodoc",
      expected: canonExpected.autodoc,
      actual: canonActual.autodoc,
    });
  }

  // Compare error
  if (canonActual.error !== canonExpected.error) {
    diffs.push({
      field: "error",
      expected: canonExpected.error,
      actual: canonActual.error,
    });
  }

  // Compare file (normalized)
  if (canonActual.file !== canonExpected.file) {
    diffs.push({
      field: "file",
      expected: canonExpected.file as string,
      actual: canonActual.file as string,
    });
  }

  // pike_version intentionally excluded from diff

  return diffs.length > 0 ? diffs : null;
}
