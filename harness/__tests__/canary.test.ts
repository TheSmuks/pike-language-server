/**
 * Canary tests: hand-verified expectations for specific corpus files.
 * These serve as harness integrity checks — if they fail, something
 * fundamental is broken in the introspection pipeline.
 */

import { describe, test, expect } from "bun:test";
import {
  runIntrospect,
  listCorpusFiles,
  CORPUS_DIR,
  getRunnerOptionsForFile,
} from "../src/runner";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { IntrospectionResult } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function introspect(filename: string): Promise<IntrospectionResult> {
  const opts = getRunnerOptionsForFile(filename);
  return runIntrospect(`corpus/files/${filename}`, opts);
}

/** Filter diagnostics by severity. */
function errors(result: IntrospectionResult) {
  return result.diagnostics.filter((d) => d.severity === "error");
}

/** Filter diagnostics by category substring. */
function byCategory(result: IntrospectionResult, cat: string) {
  return result.diagnostics.filter((d) => d.category === cat);
}

// ---------------------------------------------------------------------------
// Valid files
// ---------------------------------------------------------------------------

describe("valid corpus files", () => {
  test("basic-types.pike produces zero error diagnostics", async () => {
    const result = await introspect("basic-types.pike");
    expect(result.error).toBeNull();
    expect(errors(result)).toHaveLength(0);
  });

  test("class-create.pike compiles cleanly", async () => {
    const result = await introspect("class-create.pike");
    expect(result.error).toBeNull();
    expect(errors(result)).toHaveLength(0);
    expect(result.compilation.exit_code).toBe(0);
  });

  test("valid files have exit_code 0", async () => {
    const validFiles = [
      "basic-types.pike",
      "class-create.pike",
      "basic-collections.pike",
      "fn-lambda.pike",
    ];
    for (const f of validFiles) {
      const result = await introspect(f);
      expect(result.compilation.exit_code).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Error corpus files — specific expectations
// ---------------------------------------------------------------------------

describe("error corpus files", () => {
  test("err-type-assign.pike produces type mismatch errors at expected lines", async () => {
    const result = await introspect("err-type-assign.pike");
    expect(result.error).toBeNull();

    const typeMismatches = byCategory(result, "type_mismatch");
    expect(typeMismatches.length).toBeGreaterThanOrEqual(2);
    // Lines from Pike without --strict (source has #pragma strict_types already)
    const lines = typeMismatches.map((d) => d.line);
    expect(lines).toContain(12);
    expect(lines).toContain(18);
  });

  test("err-undef-var.pike produces undefined_identifier diagnostics", async () => {
    const result = await introspect("err-undef-var.pike");
    expect(result.error).toBeNull();

    const undefs = byCategory(result, "undefined_identifier");
    expect(undefs.length).toBeGreaterThanOrEqual(1);
    // Should mention the identifiers from the source
    const messages = undefs.map((d) => d.message);
    const joined = messages.join(" ");
    expect(joined).toContain("nonexistent_var");
  });

  test("err-arity-few.pike produces wrong_arity diagnostics", async () => {
    const result = await introspect("err-arity-few.pike");
    expect(result.error).toBeNull();

    const arity = byCategory(result, "wrong_arity");
    expect(arity.length).toBeGreaterThanOrEqual(1);
    const messages = arity.map((d) => d.message).join(" ");
    expect(messages).toMatch(/Too few arguments/);
  });

  test("err-syntax-basic.pike produces syntax_error diagnostics", async () => {
    const result = await introspect("err-syntax-basic.pike");
    expect(result.error).toBeNull();

    const syntax = byCategory(result, "syntax_error");
    expect(syntax.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Deliberately broken file
// ---------------------------------------------------------------------------

describe("deliberately broken file", () => {
  const tmpDir = join(CORPUS_DIR, "__canary_tmp__");

  test("a broken file produces at least 1 diagnostic", async () => {
    const broken = "#pragma strict_types\nint x = \"broken\";\n";
    mkdirSync(tmpDir, { recursive: true });
    const brokenPath = join(tmpDir, "broken-canary.pike");
    writeFileSync(brokenPath, broken, "utf-8");

    try {
      const result = await runIntrospect(`corpus/files/__canary_tmp__/broken-canary.pike`, { strict: true });
      expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Structural canaries — output shape
// ---------------------------------------------------------------------------

describe("output structure", () => {
  const files = listCorpusFiles();

  test("pike_version is a non-empty string", async () => {
    // Just test one file — pike_version is the same for all
    const result = await introspect("basic-types.pike");
    expect(result.pike_version).toBeTruthy();
    expect(typeof result.pike_version).toBe("string");
    expect(result.pike_version.length).toBeGreaterThan(0);
  });

  test("every result has a diagnostics array", async () => {
    for (const f of files.slice(0, 5)) {
      const result = await introspect(f);
      expect(Array.isArray(result.diagnostics)).toBe(true);
    }
  });

  test("every result has a compilation object with exit_code", async () => {
    for (const f of files.slice(0, 5)) {
      const result = await introspect(f);
      expect(result.compilation).toBeDefined();
      expect(typeof result.compilation.exit_code).toBe("number");
      expect(typeof result.compilation.strict_types).toBe("boolean");
    }
  });
});
