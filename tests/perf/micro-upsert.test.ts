/**
 * Micro-benchmark: isolate the per-file cost of upsertBackgroundFile.
 *
 * Measures each step separately to find the exact bottleneck.
 * Run: bun test tests/perf/micro-upsert.test.ts
 *
 * For phase-level breakdown inside buildSymbolTable, run with:
 *   PIKE_LSP_PROFILE=1 bun test tests/perf/micro-upsert.test.ts
 * and check the profiler report for declarationPass / buildTable /
 * wireInheritance / referencePass timings.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { WorkspaceIndex } from "../../server/src/features/workspaceIndex";
import { buildSymbolTable } from "../../server/src/features/symbolTable";
import { initParser, parse } from "../../server/src/parser";

const N = 500;

function hrMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

describe("Micro-benchmark: upsertBackgroundFile breakdown", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("measure each step", () => {
    const content = `class Test {
  int fn1(int x) { return x + 1; }
  int fn2(int x) { return x + 2; }
  int fn3() { return 3; }
}`;
    const uri = "file:///tmp/micro/f0.pike";

    // Pre-parse trees for reuse
    const trees = [];
    for (let i = 0; i < N; i++) trees.push(parse(content));

    // Step 1: parse only
    let t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      const t = parse(content);
      t.delete();
    }
    const parseMs = hrMs(t0);

    // Step 2: buildSymbolTable only
    const index = new WorkspaceIndex({ workspaceRoot: "/tmp/micro" });
    t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      buildSymbolTable(trees[i % trees.length], `file:///tmp/micro/f${i}.pike`, 1);
    }
    const buildTableMs = hrMs(t0);

    // Step 3: hashContent only
    t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      let hash = 5381;
      for (let j = 0; j < content.length; j++) {
        hash = ((hash << 5) + hash + content.charCodeAt(j)) >>> 0;
      }
    }
    const hashMs = hrMs(t0);

    // Step 4: full upsertBackgroundFile
    const index2 = new WorkspaceIndex({ workspaceRoot: "/tmp/micro2" });
    t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      index2.upsertBackgroundFile(`file:///tmp/micro2/f${i}.pike`, 1, trees[i], content);
    }
    const upsertMs = hrMs(t0);

    // Step 5: Map.set only (overhead of files Map + generation++)
    const index3 = new WorkspaceIndex({ workspaceRoot: "/tmp/micro3" });
    const fakeEntry = {
      uri: "", version: 1, symbolTable: null as any, pikeVersion: null as any,
      dependencies: new Set<string>(),
      lastModSource: 0 as any, contentHash: "", stale: false,
    };
    t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      fakeEntry.uri = `file:///tmp/micro3/f${i}.pike`;
      (index3 as any).files.set(fakeEntry.uri, fakeEntry);
      (index3 as any).generation++;
    }
    const mapMs = hrMs(t0);

    console.log("\n  === MICRO-BENCHMARK BREAKDOWN ===");
    console.log(`  parse × ${N}:              ${parseMs.toFixed(1)}ms  (${(parseMs/N).toFixed(3)}ms/file)`);
    console.log(`  buildSymbolTable × ${N}:   ${buildTableMs.toFixed(1)}ms  (${(buildTableMs/N).toFixed(3)}ms/file)`);
    console.log(`  hashContent × ${N}:        ${hashMs.toFixed(1)}ms  (${(hashMs/N).toFixed(3)}ms/file)`);
    console.log(`  Map.set+gen++ × ${N}:      ${mapMs.toFixed(1)}ms  (${(mapMs/N).toFixed(3)}ms/file)`);
    console.log(`  upsertBackgroundFile × ${N}: ${upsertMs.toFixed(1)}ms  (${(upsertMs/N).toFixed(3)}ms/file)`);
    console.log(`  sum of parts:             ${(parseMs + buildTableMs + hashMs + mapMs).toFixed(1)}ms`);
    console.log(`  unaccounted:              ${(upsertMs - buildTableMs - hashMs - mapMs).toFixed(1)}ms`);
    console.log("  =================================\n");

    for (const t of trees) t.delete();
    expect(true).toBe(true);
  });

  test("buildSymbolTable phase breakdown", () => {
    // Isolates the 4 phases inside buildSymbolTable:
    // declarationPass, buildTable, wireInheritance, referencePass
    const content = `class Test {
  int fn1(int x) { return x + 1; }
  int fn2(int x) { return x + 2; }
  int fn3() { return 3; }
}`;
    const N_PHASES = 1000;
    const trees: import("web-tree-sitter").Tree[] = [];
    for (let i = 0; i < N_PHASES; i++) {
      trees.push(parse(content));
    }

    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N_PHASES; i++) {
      buildSymbolTable(trees[i]!, `file:///tmp/perf/f${i}.pike`, 1);
    }
    const totalMs = hrMs(t0);

    console.log(`\n  === buildSymbolTable × ${N_PHASES} ===`);
    console.log(`  total: ${totalMs.toFixed(1)}ms  (${(totalMs/N_PHASES).toFixed(3)}ms/file)`);
    console.log(`  With PIKE_LSP_PROFILE=1, check the profiler report for per-phase breakdown.`);
    console.log("  ===============================\n");

    for (const t of trees) t.delete();
    expect(true).toBe(true);
  });
});