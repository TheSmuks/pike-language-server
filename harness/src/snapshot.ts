/**
 * Snapshot read/write/diff for harness test results.
 *
 * The canonicalizer and diff are fully generic — they handle arbitrary
 * top-level fields and deeply nested structures. When Phase 3+ adds
 * `symbols`, `types`, etc., no code changes are needed here.
 *
 * Key principle: pike_version is informational and excluded from diff.
 * Everything else is compared recursively with sorted keys.
 */

import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import type { IntrospectionResult, SnapshotDiff } from "./types";
import { SNAPSHOTS_DIR } from "./runner";

// ---------------------------------------------------------------------------
// Canonical serialization — recursively sorted keys at every level
// ---------------------------------------------------------------------------

/**
 * Recursively sort all object keys for deterministic output.
 * Arrays are traversed element-by-element; primitives pass through unchanged.
 */
function deepSortKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(deepSortKeys);
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = deepSortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Canonical JSON string with sorted keys at every nesting level.
 */
export function canonicalStringify(obj: unknown): string {
  return JSON.stringify(deepSortKeys(obj));
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
  writeFileSync(path, JSON.stringify(deepSortKeys(data), null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Diff — generic field-by-field comparison
// ---------------------------------------------------------------------------

/** Fields that are informational and excluded from comparison. */
const EXCLUDED_DIFF_FIELDS = new Set(["pike_version"]);

/**
 * Compare two introspection results. Returns null if identical, or an array
 * of per-field diffs. Comparison is recursive with canonical key ordering.
 *
 * `pike_version` is informational and excluded from diff.
 * Any top-level field present in one but not the other is a diff.
 */
export function diffSnapshot(
  actual: IntrospectionResult,
  expected: IntrospectionResult,
): SnapshotDiff[] | null {
  const diffs: SnapshotDiff[] = [];

  // Gather the union of all top-level keys (minus excluded)
  const allKeys = new Set([
    ...Object.keys(actual as Record<string, unknown>),
    ...Object.keys(expected as Record<string, unknown>),
  ]);

  for (const key of allKeys) {
    if (EXCLUDED_DIFF_FIELDS.has(key)) continue;

    const actualVal = (actual as Record<string, unknown>)[key];
    const expectedVal = (expected as Record<string, unknown>)[key];

    const actualCanon = canonicalStringify(actualVal);
    const expectedCanon = canonicalStringify(expectedVal);

    if (actualCanon !== expectedCanon) {
      diffs.push({
        field: key,
        expected: deepSortKeys(expectedVal),
        actual: deepSortKeys(actualVal),
      });
    }
  }

  return diffs.length > 0 ? diffs : null;
}

// ---------------------------------------------------------------------------
// Export deepSortKeys for unit testing
// ---------------------------------------------------------------------------

export { deepSortKeys };
