/**
 * Golden-file diagnostics tests.
 *
 * For every corpus file, this test runs the LSP's tree-sitter diagnostic
 * pipeline (parse diagnostics + lint rules) and compares the output against
 * a golden snapshot. This catches regressions in:
 *
 *   - Parse error detection (tree-sitter ERROR node handling)
 *   - Lint rule output (unused symbols, unreachable code, missing returns, unused imports)
 *   - Diagnostic range accuracy (line/column positions)
 *
 * These tests do NOT require Pike to be installed — they exercise only the
 * tree-sitter fast path (<5ms per file). Pike compiler diagnostics are
 * covered by harness/__tests__/harness.test.ts.
 *
 * How to update golden files:
 *   bun run harness/src/diagnosticsGolden.ts --diagnostics-golden
 *
 * How to verify:
 *   bun run harness/src/diagnosticsGolden.ts --diagnostics-verify
 */

import { describe, test, expect, beforeAll } from "bun:test";
import {
  listCorpusFiles,
  goldenNameForFile,
  readGolden,
  writeGolden,
  diffGolden,
  produceDiagnostics,
  GOLDEN_DIR,
  CORPUS_DIR,
} from "../src/diagnosticsGolden";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const corpusFiles = listCorpusFiles();

// ---------------------------------------------------------------------------
// 1. Every corpus file has a golden file
// ---------------------------------------------------------------------------

describe("diagnostic golden file coverage", () => {
  test("every corpus file has a golden file", () => {
    const missing: string[] = [];
    for (const f of corpusFiles) {
      const name = goldenNameForFile(f);
      if (!existsSync(join(GOLDEN_DIR, name))) {
        missing.push(f);
      }
    }
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Golden file matches current diagnostic output
// ---------------------------------------------------------------------------

describe("diagnostic golden file verification", () => {
  const results = new Map<string, Awaited<ReturnType<typeof produceDiagnostics>>>();

  beforeAll(async () => {
    for (const f of corpusFiles) {
      const absPath = resolve(CORPUS_DIR, f);
      const source = readFileSync(absPath, "utf-8");
      results.set(f, await produceDiagnostics(source, `corpus/files/${f}`));
    }
  }, 30_000);

  test.each(corpusFiles.map((f) => [f]))(
    "%s matches golden file",
    (filename: string) => {
      const name = goldenNameForFile(filename);
      const expected = readGolden(name);
      const actual = results.get(filename);

      expect(actual).toBeDefined();

      if (!expected) {
        // Self-healing: generate missing golden file
        writeGolden(name, actual!);
        return;
      }

      const diffs = diffGolden(actual!, expected);
      if (diffs.length > 0) {
        const msg = diffs.map((d) => `${d.kind}: ${d.detail}`).join("\n  ");
        throw new Error(`Golden diagnostics diff for ${filename}:\n  ${msg}`);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Error corpus files produce parse diagnostics
// ---------------------------------------------------------------------------

describe("error corpus files produce parse diagnostics", () => {
  const errorFiles = corpusFiles.filter((f) => f.startsWith("err-syntax-"));

  test.each(errorFiles.map((f) => [f]))(
    "%s has parse diagnostics",
    async (filename: string) => {
      const absPath = resolve(CORPUS_DIR, filename);
      const source = readFileSync(absPath, "utf-8");
      const result = await produceDiagnostics(source, `corpus/files/${filename}`);
      expect(result.parseCount).toBeGreaterThan(0);
    },
  );
});

// ---------------------------------------------------------------------------
// 4. Lint corpus files produce lint diagnostics
// ---------------------------------------------------------------------------

describe("lint corpus files produce lint diagnostics", () => {
  test("lint-unreachable.pike has unreachable code diagnostics", async () => {
    const absPath = resolve(CORPUS_DIR, "lint-unreachable.pike");
    const source = readFileSync(absPath, "utf-8");
    const result = await produceDiagnostics(source, "corpus/files/lint-unreachable.pike");
    expect(result.lintCount).toBeGreaterThan(0);
    // All lint diagnostics should have source starting with "pike-lsp"
    for (const d of result.diagnostics.slice(result.parseCount)) {
      expect(d.source).toMatch(/^pike-lsp/);
    }
  });

  test("lint-unused-var.pike has unused symbol diagnostics", async () => {
    const absPath = resolve(CORPUS_DIR, "lint-unused-var.pike");
    const source = readFileSync(absPath, "utf-8");
    const result = await produceDiagnostics(source, "corpus/files/lint-unused-var.pike");
    expect(result.lintCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Golden file schema validation
// ---------------------------------------------------------------------------

describe("golden file schema validation", () => {
  test("all golden files have valid schema", () => {
    for (const f of corpusFiles) {
      const name = goldenNameForFile(f);
      const golden = readGolden(name);
      if (!golden) continue;

      expect(golden).toHaveProperty("file");
      expect(golden).toHaveProperty("diagnostics");
      expect(golden).toHaveProperty("parseCount");
      expect(golden).toHaveProperty("lintCount");
      expect(typeof golden.file).toBe("string");
      expect(typeof golden.parseCount).toBe("number");
      expect(typeof golden.lintCount).toBe("number");
      expect(Array.isArray(golden.diagnostics)).toBe(true);
      expect(golden.parseCount + golden.lintCount).toBe(golden.diagnostics.length);

      for (const d of golden.diagnostics) {
        expect(d).toHaveProperty("range");
        expect(d.range).toHaveProperty("start");
        expect(d.range).toHaveProperty("end");
        expect(d.range.start).toHaveProperty("line");
        expect(d.range.start).toHaveProperty("character");
        expect(d.range.end).toHaveProperty("line");
        expect(d.range.end).toHaveProperty("character");
        expect(typeof d.message).toBe("string");
        expect(d.message.length).toBeGreaterThan(0);
      }
    }
  });
});
