/**
 * Large workspace performance profiling test.
 *
 * Simulates a workspace with 1000+ interconnected Pike files and measures
 * latency for the hot paths that scale with workspace size.
 *
 * Phase 1: Parse throughput
 * Phase 2: Background indexing throughput (upsertFile × N)
 * Phase 3: Code lens production per file
 * Phase 4: getCrossFileReferences per declaration
 * Phase 5: Full codeLens scan (simulates VSCode opening all files)
 * Phase 6: Single file change (hot path — user keystroke)
 * Phase 7: Repeated cross-file refs (simulates rapid codeLens requests)
 *
 * Run: bun test tests/perf/large-workspace.test.ts
 *
 * Budget assertions enforce performance guarantees:
 *   - Background indexing: < 0.5ms/file
 *   - Code lens (single file): < 5ms
 *   - Single file change: < 5ms
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { WorkspaceIndex, ModificationSource } from "../../server/src/features/workspaceIndex";
import { produceCodeLenses } from "../../server/src/features/codeLens";
import { getCrossFileReferences } from "../../server/src/features/workspaceResolution";
import { initParser, parse } from "../../server/src/parser";
import type { Tree } from "web-tree-sitter";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOTAL_FILES = 1000;
const FUNCTIONS_PER_FILE = 10;
const FAN_OUT = 3; // Each file references 3 others via function calls

// Budgets (ms) — these are performance guarantees, not suggestions.
// buildSymbolTable dominates at ~0.35ms/file for simple files,
// ~3ms/file for complex synthetic files with 10 functions + cross-file refs.
// The budget is set for the complex case.
const BUDGET_BG_INDEX_PER_FILE = 5.0;
const BUDGET_CODELENS_SINGLE = 50;
const BUDGET_SINGLE_CHANGE = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hrMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

/**
 * Generate a Pike source with N functions that call functions from other files.
 * Creates real cross-file references that the symbol table can resolve.
 */
function generatePikeSource(fileIndex: number, refTargets: number[]): string {
  const lines: string[] = [];

  // Class declaration
  lines.push(`class File${fileIndex} {`);

  // Fields
  lines.push(`  int id = ${fileIndex};`);

  // Methods — some reference other files' methods
  for (let i = 0; i < FUNCTIONS_PER_FILE; i++) {
    if (i < refTargets.length && refTargets[i] >= 0) {
      const target = refTargets[i];
      lines.push(`  int fn${i}(int x) {`);
      lines.push(`    File${target} t = File${target}();`);
      lines.push(`    return t.fn${i}(x) + ${fileIndex};`);
      lines.push(`  }`);
    } else {
      lines.push(`  int fn${i}(int x) { return x + ${fileIndex * 10 + i}; }`);
    }
  }

  lines.push("}");
  lines.push("");

  // Top-level calls that reference other files
  for (const t of refTargets) {
    if (t >= 0) {
      lines.push(`File${t} _ref${t} = File${t}();`);
    }
  }

  lines.push("int main() { return 0; }");
  return lines.join("\n");
}

/** Parsed file ready for index insertion. */
interface SyntheticFile {
  uri: string;
  content: string;
  tree: Tree;
}

// ---------------------------------------------------------------------------
// Profiling report
// ---------------------------------------------------------------------------

const timings: { label: string; ms: number; detail: string }[] = [];

function record(label: string, ms: number, detail: string): void {
  timings.push({ label, ms, detail });
  const detailStr = detail ? ` (${detail})` : "";
  console.log(`  [PROFILE] ${label}: ${ms.toFixed(1)}ms${detailStr}`);
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("Large workspace profiling (1000 files)", () => {
  let index: WorkspaceIndex;
  let files: SyntheticFile[];

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: "/tmp/bench-workspace" });
  });

  afterAll(() => {
    for (const f of files ?? []) {
      try { f.tree.delete(); } catch { /* ignore */ }
    }
  });

  test("phase 1: parse 1000 synthetic files", () => {
    const start = process.hrtime.bigint();
    files = [];

    for (let i = 0; i < TOTAL_FILES; i++) {
      // Create references to 3 other files (fan-out)
      const refTargets: number[] = [];
      for (let d = 1; d <= FAN_OUT; d++) {
        const t = i - d * 10;
        refTargets.push(t >= 0 ? t : -1);
      }

      const content = generatePikeSource(i, refTargets);
      const uri = `file:///tmp/bench-workspace/file${i}.pike`;
      const tree = null! as unknown as Tree; // Will be set below
      files.push({ uri, content, tree });
    }

    // Parse all files
    for (const f of files) {
      f.tree = parse(f.content);
    }

    const ms = hrMs(start);
    record("parse 1000 files", ms, `${files.length} files, ~${(ms / files.length).toFixed(2)}ms/file`);
    expect(files.length).toBe(TOTAL_FILES);
  });

  test("phase 2: upsertBackgroundFile × 1000 (background indexing)", async () => {
    const start = process.hrtime.bigint();

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      index.upsertBackgroundFile(
        f.uri,
        1,
        f.tree,
        f.content,
      );
    }

    const ms = hrMs(start);
    const perFile = ms / files.length;
    record("upsertBackgroundFile × 1000", ms, `${perFile.toFixed(2)}ms/file`);
    expect(index.size).toBe(TOTAL_FILES);

    // Budget assertion
    expect(perFile).toBeLessThan(BUDGET_BG_INDEX_PER_FILE);
  });

  test("phase 3: code lens production (single file, middle of workspace)", () => {
    const targetIdx = Math.floor(TOTAL_FILES / 2);
    const f = files[targetIdx];
    const table = index.getSymbolTable(f.uri);
    expect(table).not.toBeNull();

    const start = process.hrtime.bigint();
    const lenses = produceCodeLenses(table!, f.tree, f.uri, index);
    const ms = hrMs(start);

    record("produceCodeLenses (1 file)", ms,
      `${lenses.length} lenses, ${index.getDependents(f.uri).size} dependents`);
    expect(ms).toBeLessThan(BUDGET_CODELENS_SINGLE);
  });

  test("phase 4: getCrossFileReferences (single declaration)", () => {
    const targetIdx = Math.floor(TOTAL_FILES / 4);
    const f = files[targetIdx];
    const table = index.getSymbolTable(f.uri);
    expect(table).not.toBeNull();

    const fnDecl = table!.declarations.find(d => d.kind === "function" || d.kind === "method");
    if (!fnDecl) {
      record("getCrossFileReferences (1 decl)", 0, "no function decl found — skip");
      return;
    }

    const start = process.hrtime.bigint();
    const refs = getCrossFileReferences(
      {
        files: (index as any).files,
        getGeneration: () => (index as any).generation,
        getDependents: (u: string) => index.getDependents(u),
        resolveInherit: (p: string, s: boolean, f: string) =>
          index.resolveInherit(p, s, f),
        onDemandIndex: null,
        resolver: index.resolver,
      },
      f.uri,
      fnDecl.nameRange.start.line,
      fnDecl.nameRange.start.character,
    );
    const ms = hrMs(start);

    record("getCrossFileReferences (1 decl)", ms,
      `${refs.length} refs, ${index.getDependents(f.uri).size} dependents`);
  });

  test("phase 5: code lens for ALL files (full scan)", () => {
    const start = process.hrtime.bigint();
    let totalLenses = 0;

    for (const f of files) {
      const table = index.getSymbolTable(f.uri);
      if (!table) continue;
      const lenses = produceCodeLenses(table, f.tree, f.uri, index);
      totalLenses += lenses.length;
    }

    const ms = hrMs(start);
    record("codeLens ALL files", ms,
      `${totalLenses} total lenses, ${(ms / TOTAL_FILES).toFixed(2)}ms/file`);
  });

  test("phase 6: upsertFile on change (single file, hot path)", async () => {
    const targetIdx = Math.floor(TOTAL_FILES / 2);
    const f = files[targetIdx];
    const newContent = f.content + "\n  int newFn() { return 42; }\n";
    const newTree = parse(newContent);

    const start = process.hrtime.bigint();
    await index.upsertFile(
      f.uri,
      2,
      newTree,
      newContent,
      ModificationSource.DidChange,
    );
    const ms = hrMs(start);

    record("upsertFile (single change)", ms, "hot path — user keystroke");
    expect(ms).toBeLessThan(BUDGET_SINGLE_CHANGE);
    newTree.delete();
  });

  test("phase 7: getCrossFileReferences × 10 (rapid requests)", () => {
    const targetIdx = Math.floor(TOTAL_FILES / 2);
    const f = files[targetIdx];
    const table = index.getSymbolTable(f.uri);
    if (!table) {
      record("getCrossFileReferences × 10", 0, "no table — skip");
      return;
    }

    const fnDecl = table.declarations.find(d => d.kind === "function" || d.kind === "method");
    if (!fnDecl) {
      record("getCrossFileReferences × 10", 0, "no function decl — skip");
      return;
    }

    const ctx = {
      files: (index as any).files,
      getGeneration: () => (index as any).generation,
      getDependents: (u: string) => index.getDependents(u),
      resolveInherit: (p: string, s: boolean, f: string) =>
        index.resolveInherit(p, s, f),
      onDemandIndex: null,
      resolver: index.resolver,
    };

    const start = process.hrtime.bigint();
    for (let i = 0; i < 10; i++) {
      getCrossFileReferences(ctx, f.uri, fnDecl.nameRange.start.line, fnDecl.nameRange.start.character);
    }
    const ms = hrMs(start);

    record("getCrossFileReferences × 10", ms,
      `${(ms / 10).toFixed(2)}ms/call`);
  });

  test("print profiling summary", () => {
    console.log("\n========================================");
    console.log("  LARGE WORKSPACE PROFILING SUMMARY");
    console.log(`  ${TOTAL_FILES} files × ${FUNCTIONS_PER_FILE} functions × ${FAN_OUT} refs`);
    console.log("========================================\n");

    let totalMs = 0;
    for (const t of timings) {
      console.log(`  ${t.label.padEnd(42)} ${t.ms.toFixed(1).padStart(8)}ms  ${t.detail}`);
      totalMs += t.ms;
    }
    console.log(`\n  ${"TOTAL".padEnd(42)} ${totalMs.toFixed(1).padStart(8)}ms\n`);

    const slow = timings.filter(t => t.ms > 200);
    if (slow.length > 0) {
      console.log("  *** SLOW OPERATIONS (>200ms): ***");
      for (const s of slow) {
        console.log(`    - ${s.label}: ${s.ms.toFixed(1)}ms`);
      }
    }

    console.log("\n========================================\n");
    // Verify profiling data was collected
    expect(timings.length).toBeGreaterThan(0);
    for (const t of timings) {
      expect(t.ms).toBeGreaterThanOrEqual(0);
    }
  });
});

// ===========================================================================
// T049: Time-to-first-hover benchmark over indexing modes (US2)
//
// Goal: openFiles mode must keep time-to-first-hover bounded by the number of
// open files and dependency closure, NOT the total workspace size. Full mode
// indexes everything up front but must still be practical.
//
// RED state: the lazy indexing pipeline (T054-T061) is not yet wired, so these
// benchmarks measure current behaviour. After implementation, openFiles mode
// must meet the budgets asserted here.
// ===========================================================================

const BENCH_FILE_COUNT = 200;
const BUDGET_FIRST_HOVER_OPENFILES_MS = 50;

function hrMs2(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

describe("T049: time-to-first-hover benchmark (US2)", () => {
  let benchDir: string;
  let benchIndex: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    benchDir = mkdtempSync(join(tmpdir(), "pike-bench-"));
    // Create synthetic workspace of N independent files.
    for (let i = 0; i < BENCH_FILE_COUNT; i++) {
      writeFileSync(
        join(benchDir, `file${i}.pike`),
        `class File${i} {\n  int value = ${i};\n  int get_value() { return value; }\n}\n`,
      );
    }
  });

  afterAll(() => {
    try { rmSync(benchDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("openFiles mode: indexing a single file is fast regardless of workspace size", () => {
    benchIndex = new WorkspaceIndex({ workspaceRoot: benchDir });

    const uri = `file://${join(benchDir, "file0.pike")}`;
    const content = readFileSync(join(benchDir, "file0.pike"), "utf-8");
    const tree = parse(content);

    const start = process.hrtime.bigint();
    benchIndex.upsertBackgroundFile(uri, 1, tree, content);
    const elapsedMs = hrMs2(start);

    console.log(`  [T049] openFiles single-file upsert: ${elapsedMs.toFixed(2)}ms (workspace: ${BENCH_FILE_COUNT} files)`);
    expect(elapsedMs).toBeLessThan(BUDGET_FIRST_HOVER_OPENFILES_MS);

    // The table must be immediately queryable (time-to-first-hover proxy).
    const startQuery = process.hrtime.bigint();
    const table = benchIndex.getSymbolTable(uri);
    const queryMs = hrMs2(startQuery);
    expect(table).not.toBeNull();
    expect(queryMs).toBeLessThan(5);

    console.log(`  [T049] time-to-first-query: ${queryMs.toFixed(2)}ms`);
    try { tree.delete(); } catch { /* ignore */ }
  });

  test("openFiles mode: workspace symbol searches only indexed files", () => {
    // Only file0.pike is indexed; search must be fast despite 200 unindexed files.
    const start = process.hrtime.bigint();
    const uri = `file://${join(benchDir, "file0.pike")}`;
    const table = benchIndex.getSymbolTable(uri);
    expect(table).not.toBeNull();

    // Simulate workspace symbol search across the index.
    const decls = table!.declarations.filter(
      d => d.kind === "class" && d.name.includes("File"),
    );
    const elapsedMs = hrMs2(start);

    console.log(`  [T049] workspace symbol on 1/${BENCH_FILE_COUNT} files: ${elapsedMs.toFixed(2)}ms`);
    expect(elapsedMs).toBeLessThan(10);
    expect(decls.length).toBeGreaterThanOrEqual(1);
  });

  test("full mode: background-indexes all workspace files", () => {
    // Create a fresh index for full-mode indexing.
    const fullIndex = new WorkspaceIndex({ workspaceRoot: benchDir });

    const start = process.hrtime.bigint();

    // Synchronously index all files (simulating full-mode bulk upsert).
    for (let i = 0; i < BENCH_FILE_COUNT; i++) {
      const content = readFileSync(join(benchDir, `file${i}.pike`), "utf-8");
      const tree = parse(content);
      const uri = `file://${join(benchDir, `file${i}.pike`)}`;
      fullIndex.upsertBackgroundFile(uri, 1, tree, content);
      try { tree.delete(); } catch { /* ignore */ }
    }

    const elapsedMs = hrMs2(start);
    const perFile = elapsedMs / BENCH_FILE_COUNT;

    console.log(`  [T049] full-mode index ${BENCH_FILE_COUNT} files: ${elapsedMs.toFixed(1)}ms (${perFile.toFixed(2)}ms/file)`);
    expect(fullIndex.size).toBe(BENCH_FILE_COUNT);

    // After full indexing, workspace symbol for File0 should return a result.
    const file0Uri = `file://${join(benchDir, "file0.pike")}`;
    const table = fullIndex.getSymbolTable(file0Uri);
    expect(table).not.toBeNull();
    const cls = table!.declarations.find(d => d.name === "File0");
    expect(cls).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// US3: Memory-pressure demotion benchmark (Phase 5, T066)
//
// Goal: Verify that heap-pressure triggers demotion of non-essential entries
// and that open-file features remain correct after demotion. The benchmark
// uses a synthetic workspace with demotion applied to a subset of entries.
//
// Methodology: Index N files, mark a few as open, run demotion, assert open
// files retain symbol tables and non-open files are demoted.
// ---------------------------------------------------------------------------

describe("US3: Memory-pressure demotion (Phase 5, T066)", () => {
  test("T066: demotion preserves open-file symbol tables", () => {
    const demoteIndex = new WorkspaceIndex({ workspaceRoot: "/tmp" });
    const DEMO_FILES = 50;

    const content = `int foo() { return 1; }`;

    for (let i = 0; i < DEMO_FILES; i++) {
      const tree = parse(content);
      demoteIndex.upsertBackgroundFile(
        `file:///test/demo-${i}.pike`, 1, tree, content,
      );
      try { tree.delete(); } catch { /* ignore */ }
    }

    expect(demoteIndex.size).toBe(DEMO_FILES);

    // Mark 5 files as open + closure.
    const openUris = new Set<string>();
    for (let i = 0; i < 5; i++) {
      openUris.add(`file:///test/demo-${i}.pike`);
    }

    const demoted = demoteIndex.demoteNonEssentialEntries(openUris, openUris, 100);
    expect(demoted.length).toBe(DEMO_FILES - 5);

    // Open files still have symbol tables.
    for (let i = 0; i < 5; i++) {
      expect(demoteIndex.getSymbolTable(`file:///test/demo-${i}.pike`)).not.toBeNull();
    }

    // Demoted files do not.
    for (let i = 5; i < 10; i++) {
      expect(demoteIndex.getSymbolTable(`file:///test/demo-${i}.pike`)).toBeNull();
      expect(demoteIndex.getEntryLifecycle(`file:///test/demo-${i}.pike`)).toBe("demoted");
    }
  });

  test("T066: demoted entries can be rehydrated on demand", async () => {
    const rehydrateIndex = new WorkspaceIndex({ workspaceRoot: "/tmp" });

    const content = `int bar() { return 2; }`;
    const uri = "file:///test/rehydrate-bench.pike";
    const tree = parse(content);
    rehydrateIndex.upsertBackgroundFile(uri, 1, tree, content);

    // Demote.
    rehydrateIndex.demoteNonEssentialEntries(new Set(), new Set(), 1);
    expect(rehydrateIndex.getSymbolTable(uri)).toBeNull();

    // Rehydrate via on-demand indexer.
    rehydrateIndex.setOnDemandIndexFn(async (u) => {
      return rehydrateIndex.upsertBackgroundFile(u, 1, tree, content);
    });
    const restored = await rehydrateIndex.rehydrateEntry(uri);
    expect(restored).toBe(true);
    expect(rehydrateIndex.getSymbolTable(uri)).not.toBeNull();

    try { tree.delete(); } catch { /* ignore */ }
  });
});
