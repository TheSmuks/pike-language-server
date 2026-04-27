/**
 * Phase 2 tests: verify that the LSP server's documentSymbol output
 * matches Pike's ground truth from the harness snapshots.
 *
 * Test categories:
 * 1. Symbol comparison — tree-sitter output vs Pike snapshots
 * 2. KL-007 / parse error handling — partial results on broken input
 * 3. Performance — cold start and warm parse budgets
 * 4. Canary — non-trivial multi-level symbol tree
 * 5. Determinism — identical output across repeated parses
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve, join } from "node:path";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { initParser, parse } from "../../server/src/parser";
import { getDocumentSymbols, SymbolKind } from "../../server/src/features/documentSymbol";
import { getParseDiagnostics } from "../../server/src/features/diagnostics";
import { readSnapshot } from "../src/snapshot";
import { listCorpusFiles, CORPUS_DIR } from "../src/runner";
import type { IntrospectionResult, SymbolInfo } from "../src/types";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const WASM_PATH = resolve(__dirname, "../../server/tree-sitter-pike.wasm");

let parserReady = false;

beforeAll(async () => {
  await initParser(WASM_PATH);
  parserReady = true;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FlatSymbol {
  name: string;
  kind: number;
}

/** Flatten a DocumentSymbol tree into name→kind pairs (top-level only). */
function flatTopLevel(symbols: ReturnType<typeof getDocumentSymbols>): FlatSymbol[] {
  return symbols.map((s) => ({ name: s.name, kind: s.kind }));
}

/** Flatten entire DocumentSymbol tree (recursive) including children. */
function flatAll(
  symbols: ReturnType<typeof getDocumentSymbols>,
): FlatSymbol[] {
  const out: FlatSymbol[] = [];
  function walk(list: typeof symbols) {
    for (const s of list) {
      out.push({ name: s.name, kind: s.kind });
      if (s.children) walk(s.children);
    }
  }
  walk(symbols);
  return out;
}

/** Kind compatibility: tree-sitter SymbolKind → Pike kind string. */
const TS_KIND_TO_PIKE: Partial<Record<number, string[]>> = {
  [SymbolKind.Class]: ["class"],
  [SymbolKind.Function]: ["function"],
  [SymbolKind.Variable]: ["variable"],
  [SymbolKind.Constant]: ["variable"],
  [SymbolKind.Enum]: ["unknown"],
  [SymbolKind.EnumMember]: ["variable"],
  // Pike doesn't report imports or typedefs — these are tree-sitter-only
  [SymbolKind.Module]: [],
  [SymbolKind.TypeParameter]: [],
};

/** Kinds that tree-sitter reports but Pike never reports. */
const TS_ONLY_KINDS = new Set([
  SymbolKind.Module,
  SymbolKind.TypeParameter,
]);

function corpusSource(name: string): string {
  const base = name.endsWith(".pike") || name.endsWith(".pmod") ? name : `${name}.pike`;
  const path = join(CORPUS_DIR, base);
  return readFileSync(path, "utf-8");
}

function snapshotFor(name: string): IntrospectionResult | null {
  // Strip extension if present
  const stem = name.replace(/\.(pike|pmod)$/, "");
  return readSnapshot(stem);
}

// ---------------------------------------------------------------------------
// 1. Symbol comparison tests
// ---------------------------------------------------------------------------

const corpusFiles = listCorpusFiles();

// Filter to files whose snapshots have non-empty symbols
const filesWithSymbols = corpusFiles.filter((f) => {
  const snap = snapshotFor(f);
  return snap && snap.symbols && snap.symbols.length > 0;
});

describe("symbol comparison: tree-sitter vs Pike snapshots", () => {
  test.each(filesWithSymbols.map((f) => [f]))(
    "%s — top-level symbols present in Pike snapshot",
    (filename: string) => {
      const source = corpusSource(filename);
      const tree = parse(source);
      const tsSymbols = getDocumentSymbols(tree);

      const snap = snapshotFor(filename)!;
      const pikeNames = new Set(snap.symbols.map((s) => s.name));

      for (const sym of tsSymbols) {
        // Imports and typedefs are tree-sitter-only; Pike never reports them
        if (TS_ONLY_KINDS.has(sym.kind)) continue;

        if (!pikeNames.has(sym.name)) {
          // Check for enum member: Pike may report them as top-level variables
          const pikeVars = snap.symbols.filter(
            (s) => s.kind === "variable" && s.name === sym.name,
          );
          if (pikeVars.length > 0) continue;

          // Enum type itself may appear as "unknown" in Pike
          const pikeUnknowns = snap.symbols.filter(
            (s) => s.kind === "unknown" && s.name === sym.name,
          );
          if (pikeUnknowns.length > 0) continue;

          throw new Error(
            `Tree-sitter symbol "${sym.name}" (kind=${sym.kind}) not found in Pike symbols: ${JSON.stringify(snap.symbols)}`,
          );
        }
      }

      tree.delete();
    },
  );

  test.each(filesWithSymbols.map((f) => [f]))(
    "%s — Pike class/function symbols appear in tree-sitter output",
    (filename: string) => {
      const source = corpusSource(filename);
      const tree = parse(source);
      const tsSymbols = getDocumentSymbols(tree);
      const tsNames = new Set(tsSymbols.map((s) => s.name));

      const snap = snapshotFor(filename)!;
      const pikeClassesAndFunctions = snap.symbols.filter(
        (s) => s.kind === "class" || s.kind === "function",
      );

      for (const psym of pikeClassesAndFunctions) {
        expect(tsNames.has(psym.name)).toBe(true);
      }

      tree.delete();
    },
  );

  test.each(filesWithSymbols.map((f) => [f]))(
    "%s — no duplicate symbol names at top level",
    (filename: string) => {
      const source = corpusSource(filename);
      const tree = parse(source);
      const tsSymbols = getDocumentSymbols(tree);

      const names = tsSymbols.map((s) => s.name);
      const unique = new Set(names);

      // Duplicates only matter for non-import/typedef symbols
      const nonImportNames = tsSymbols
        .filter((s) => !TS_ONLY_KINDS.has(s.kind))
        .map((s) => s.name);
      const uniqueNonImport = new Set(nonImportNames);

      expect(nonImportNames.length).toBe(uniqueNonImport.size);

      tree.delete();
    },
  );

  test.each(filesWithSymbols.map((f) => [f]))(
    "%s — ranges within file bounds",
    (filename: string) => {
      const source = corpusSource(filename);
      const lines = source.split("\n");
      const maxLine = lines.length - 1; // 0-based
      const tree = parse(source);
      const tsSymbols = getDocumentSymbols(tree);

      function checkRange(sym: typeof tsSymbols[0]) {
        expect(sym.range.start.line).toBeGreaterThanOrEqual(0);
        expect(sym.range.end.line).toBeLessThanOrEqual(maxLine);
        expect(sym.range.start.line).toBeLessThanOrEqual(sym.range.end.line);
        if (sym.children) {
          for (const child of sym.children) {
            checkRange(child);
            // Child range must be within parent range
            expect(child.range.start.line).toBeGreaterThanOrEqual(
              sym.range.start.line,
            );
            expect(child.range.end.line).toBeLessThanOrEqual(
              sym.range.end.line,
            );
          }
        }
      }

      for (const sym of tsSymbols) {
        checkRange(sym);
      }

      tree.delete();
    },
  );

  test("class symbols have children (methods/variables)", () => {
    const source = corpusSource("class-create.pike");
    const tree = parse(source);
    const tsSymbols = getDocumentSymbols(tree);

    const classes = tsSymbols.filter((s) => s.kind === SymbolKind.Class);
    // class-create has 4 classes, at least some should have children
    const withChildren = classes.filter(
      (c) => c.children && c.children.length > 0,
    );

    expect(classes.length).toBeGreaterThanOrEqual(4);
    expect(withChildren.length).toBeGreaterThan(0);

    tree.delete();
  });
});

// ---------------------------------------------------------------------------
// 2. KL-007 / parse error handling
// ---------------------------------------------------------------------------

describe("parse error handling (KL-007)", () => {
  const tmpDir = join(__dirname, "__kl007_tmp__");

  const synthetics: { name: string; source: string }[] = [
    {
      name: "partial-error.pike",
      source: [
        'int x = 1;',
        'string y = "hello";',
        '// valid declarations above, error below',
        'class Broken {',
        '  void create() {',
        '    // missing closing brace — error in middle',
        '',
      ].join("\n"),
    },
    {
      name: "multi-error.pike",
      source: [
        'int a = ;',         // syntax error: missing value
        'class Foo {',       // unclosed class
        'string b = ;',      // another syntax error
        'void bar( {',       // malformed function
        '',
      ].join("\n"),
    },
    {
      name: "trailing-error.pike",
      source: [
        '// Valid code first',
        'int valid_var = 42;',
        'string valid_fn() { return "ok"; }',
        '',
        '// Then garbage',
        '}}} broken',
        '',
      ].join("\n"),
    },
  ];

  afterAll(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test.each(synthetics.map((s) => [s.name, s.source]))(
    "%s — partial symbols returned despite errors",
    (name: string, source: string) => {
      const tree = parse(source);
      const symbols = getDocumentSymbols(tree);
      const diagnostics = getParseDiagnostics(tree);

      // Must get at least one diagnostic
      expect(diagnostics.length).toBeGreaterThan(0);

      // Must get partial results (possibly empty for severely broken files,
      // but the parser should not crash)
      expect(Array.isArray(symbols)).toBe(true);

      // If we got symbols, they should come from parseable portions
      for (const sym of symbols) {
        expect(sym.name.length).toBeGreaterThan(0);
      }

      tree.delete();
    },
  );

  test("partial-error returns symbols from valid portion", () => {
    const source = synthetics[0].source;
    const tree = parse(source);
    const symbols = getDocumentSymbols(tree);

    // The valid declarations at the top (x, y) should appear as symbols
    const names = symbols.map((s) => s.name);
    // Tree-sitter should pick up at least some valid declarations
    expect(symbols.length).toBeGreaterThan(0);

    tree.delete();
  });

  test("trailing-error preserves leading valid symbols", () => {
    const source = synthetics[2].source;
    const tree = parse(source);
    const symbols = getDocumentSymbols(tree);
    const names = new Set(symbols.map((s) => s.name));

    // The valid declarations should be recovered
    expect(names.has("valid_var")).toBe(true);

    tree.delete();
  });
});

// ---------------------------------------------------------------------------
// 3. Performance tests
// ---------------------------------------------------------------------------

describe("performance", () => {
  test("cold start: parser init + first parse < 2000ms", async () => {
    // We can't fully reset the parser, but we can measure initParser when
    // it's already initialized (should be near-zero) plus a parse.
    // For a true cold start measurement, we verify the WASM loads and
    // the first parse completes within budget.
    const source = corpusSource("class-create.pike");

    const start = performance.now();
    await initParser(WASM_PATH); // no-op if already initialized, but measures path
    const tree = parse(source);
    const elapsed = performance.now() - start;

    tree.delete();
    expect(elapsed).toBeLessThan(2000);
  });

  test("warm parse: 10 files average < 200ms", () => {
    const files = filesWithSymbols.slice(0, 10);
    if (files.length < 3) {
      throw new Error("Need at least 3 corpus files for warm parse test");
    }

    // Warm up
    const warmSource = corpusSource(files[0]);
    const warmTree = parse(warmSource);
    warmTree.delete();

    const timings: number[] = [];
    for (const f of files) {
      const source = corpusSource(f);
      const start = performance.now();
      const tree = parse(source);
      const elapsed = performance.now() - start;
      tree.delete();
      timings.push(elapsed);
    }

    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    expect(avg).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// 4. Canary: non-trivial multi-level symbol tree
// ---------------------------------------------------------------------------

describe("canary: class-create.pike produces deep symbol tree", () => {
  const source = corpusSource("class-create.pike");
  let symbols: ReturnType<typeof getDocumentSymbols>;

  beforeAll(() => {
    const tree = parse(source);
    symbols = getDocumentSymbols(tree);
    tree.delete();
  });

  test("at least 4 top-level symbols (Base, Middle, Leaf, Simple, main)", () => {
    expect(symbols.length).toBeGreaterThanOrEqual(4);
  });

  test("at least one Class with children (methods)", () => {
    const classesWithChildren = symbols.filter(
      (s) =>
        s.kind === SymbolKind.Class &&
        s.children &&
        s.children.length > 0,
    );
    expect(classesWithChildren.length).toBeGreaterThan(0);
  });

  test("3 levels of nesting: program → class → method", () => {
    function maxDepth(list: typeof symbols, depth: number): number {
      if (!list || list.length === 0) return depth;
      let max = depth;
      for (const s of list) {
        if (s.children && s.children.length > 0) {
          const childDepth = maxDepth(s.children, depth + 1);
          if (childDepth > max) max = childDepth;
        }
      }
      return max;
    }

    // depth starts at 1 (top-level symbols), children are depth 2
    const depth = maxDepth(symbols, 1);
    expect(depth).toBeGreaterThanOrEqual(2);
  });

  test("children have correct SymbolKind values", () => {
    const classes = symbols.filter((s) => s.kind === SymbolKind.Class);
    for (const cls of classes) {
      if (!cls.children) continue;
      for (const child of cls.children) {
        // Children of a class should be functions (methods), variables, constants, or inherits (Module)
        const validKinds = [
          SymbolKind.Function,
          SymbolKind.Variable,
          SymbolKind.Constant,
          SymbolKind.Module,
        ];
        expect(validKinds).toContain(child.kind);
      }
    }
  });

  test("children ranges are strictly within parent range", () => {
    const classes = symbols.filter((s) => s.kind === SymbolKind.Class);
    for (const cls of classes) {
      if (!cls.children) continue;
      for (const child of cls.children) {
        // Child must start at or after parent start
        expect(child.range.start.line).toBeGreaterThanOrEqual(
          cls.range.start.line,
        );
        // Child must end at or before parent end
        expect(child.range.end.line).toBeLessThanOrEqual(
          cls.range.end.line,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Determinism
// ---------------------------------------------------------------------------

describe("determinism: identical output on repeated parses", () => {
  const deterministicFiles = [
    "class-create.pike",
    "basic-types.pike",
    "enum-basic.pike",
  ];

  test.each(deterministicFiles)(
    "%s — 10 parses produce identical symbols",
    (filename: string) => {
      const source = corpusSource(filename);

      const runs: string[] = [];
      for (let i = 0; i < 10; i++) {
        const tree = parse(source);
        const symbols = getDocumentSymbols(tree);
        runs.push(JSON.stringify(symbols));
        tree.delete();
      }

      // All runs should be identical
      const first = runs[0];
      for (let i = 1; i < runs.length; i++) {
        expect(runs[i]).toBe(first);
      }
    },
  );
});
