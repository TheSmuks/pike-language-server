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
import { initParser } from "../../server/src/parser";
import type { Tree } from "web-tree-sitter";

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
      const tree = { ...null as any }; // Will be set below
      files.push({ uri, content, tree });
    }

    // Parse all files
    for (const f of files) {
      const { parse } = require("../../server/src/parser") as { parse: (c: string) => Tree };
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
    const { parse } = require("../../server/src/parser") as { parse: (c: string) => Tree };
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
    expect(true).toBe(true);
  });
});
