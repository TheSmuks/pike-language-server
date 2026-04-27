/**
 * Main harness tests: snapshot coverage, determinism, mutation detection.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import {
  listCorpusFiles,
  runIntrospect,
  runAllCorpus,
  CORPUS_DIR,
  SNAPSHOTS_DIR,
  getRunnerOptionsForFile,
  snapshotNameForFile,
} from "../src/runner";
import { readSnapshot, diffSnapshot, writeSnapshot } from "../src/snapshot";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { IntrospectionResult } from "../src/types";

const corpusFiles = listCorpusFiles();

// ---------------------------------------------------------------------------
// 1. Every corpus file has a snapshot
// ---------------------------------------------------------------------------

describe("snapshot coverage", () => {
  test("every corpus file has a snapshot", () => {
    const missing: string[] = [];
    for (const f of corpusFiles) {
      const name = snapshotNameForFile(f);
      if (!existsSync(join(SNAPSHOTS_DIR, `${name}.json`))) {
        missing.push(f);
      }
    }
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Snapshot matches ground truth (run introspect, compare)
// ---------------------------------------------------------------------------

describe("snapshot matches ground truth", () => {
  let results: Map<string, IntrospectionResult>;

  beforeAll(async () => {
    results = await runAllCorpus();
  }, 60_000);  // 60s timeout: compiling 35 files takes time

  test.each(corpusFiles.map((f) => [f]))(
    "%s matches snapshot",
    (filename: string) => {
      const name = snapshotNameForFile(filename);
      const expected = readSnapshot(name);
      const actual = results.get(filename);

      expect(actual).toBeDefined();
      if (!expected) {
        // Generate missing snapshot so the test suite is self-healing
        writeSnapshot(name, actual!);
        return;
      }

      const diffs = diffSnapshot(actual!, expected);
      if (diffs) {
        const msg = diffs
          .map((d) => `${d.field}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`)
          .join("\n  ");
        throw new Error(`Snapshot diff for ${filename}:\n  ${msg}`);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Two consecutive runs produce identical output (determinism)
// ---------------------------------------------------------------------------

describe("determinism", () => {
  const deterministicFiles = ["basic-types.pike", "err-type-assign.pike", "class-create.pike"];

  test.each(deterministicFiles)("two runs of %s are identical", async (filename: string) => {
    const opts = getRunnerOptionsForFile(filename);
    const first = await runIntrospect(`corpus/files/${filename}`, opts);
    const second = await runIntrospect(`corpus/files/${filename}`, opts);

    const diffs = diffSnapshot(first, second);
    if (diffs) {
      const msg = diffs
        .map((d) => `${d.field}: ${JSON.stringify(d.expected)} vs ${JSON.stringify(d.actual)}`)
        .join("\n  ");
      throw new Error(`Non-deterministic output for ${filename}:\n  ${msg}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Modifying a corpus file produces a diff
// ---------------------------------------------------------------------------

describe("mutation detection", () => {
  const tmpDir = join(CORPUS_DIR, "__test_tmp__");

  test("modifying a corpus file produces a diff", async () => {
    // Read basic-types.pike and inject an error
    const { readFileSync } = await import("node:fs");
    const original = readFileSync(join(CORPUS_DIR, "basic-types.pike"), "utf-8");

    // Add a deliberate type error at the end
    const mutated = original + '\nstring broken = 42;\n';

    mkdirSync(tmpDir, { recursive: true });
    const mutatedPath = join(tmpDir, "basic-types-mutated.pike");
    writeFileSync(mutatedPath, mutated, "utf-8");

    try {
      const result = await runIntrospect(`corpus/files/__test_tmp__/basic-types-mutated.pike`, { strict: true });
      const snapshot = readSnapshot("basic-types");

      // The mutated file should have different diagnostics than the original
      const diffs = diffSnapshot(result, snapshot!);
      expect(diffs).not.toBeNull();
      expect(diffs!.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. All snapshots have valid schema
// ---------------------------------------------------------------------------

describe("snapshot schema validation", () => {
  test("all snapshots have valid schema", () => {
    for (const f of corpusFiles) {
      const name = f.replace(/\.(pike|pmod)$/, "");
      const snap = readSnapshot(name);
      if (!snap) continue; // covered by coverage test above

      expect(snap).toHaveProperty("file");
      expect(snap).toHaveProperty("pike_version");
      expect(snap).toHaveProperty("compilation");
      expect(snap).toHaveProperty("diagnostics");
      expect(snap).toHaveProperty("autodoc");
      expect(snap).toHaveProperty("symbols");
      expect(snap).toHaveProperty("error");

      expect(typeof snap.file).toBe("string");
      expect(typeof snap.pike_version).toBe("string");
      expect(typeof snap.compilation.exit_code).toBe("number");
      expect(typeof snap.compilation.strict_types).toBe("boolean");
      expect(Array.isArray(snap.diagnostics)).toBe(true);
    }
  });
});
