import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Verifies that pike.tmLanguage.json contains all required keyword captures.
 * This test performs JSON-level validation only — it does NOT tokenize Pike source.
 *
 * Supports both flat grammar (top-level patterns) and repository-based grammar
 * (patterns reference #name includes, actual patterns live in repository).
 */

/** Collect all patterns from grammar, flattening repository refs. */
function collectPatterns(grammar: Record<string, unknown>): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];

  // Top-level patterns
  const topLevel = grammar.patterns as Array<Record<string, unknown>> | undefined;
  if (topLevel) {
    for (const p of topLevel) {
      results.push(p);
    }
  }

  // Repository patterns (recursively include sub-patterns)
  const repo = grammar.repository as Record<string, Record<string, unknown>> | undefined;
  if (repo) {
    for (const entry of Object.values(repo)) {
      // Repository entries can be { patterns: [...] } or direct arrays
      const patterns = Array.isArray(entry) ? entry : entry.patterns as Array<Record<string, unknown>> | undefined;
      if (!patterns) continue;
      for (const p of patterns) {
        results.push(p);
        // Sub-patterns within a pattern (e.g., autodoc tags inside doc comments)
        const sub = p.patterns as Array<Record<string, unknown>> | undefined;
        if (sub) {
          for (const sp of sub) {
            results.push(sp);
          }
        }
      }
    }
  }

  return results;
}

describe("pike.tmLanguage.json", () => {
  const grammarPath = resolve(__dirname, "../../client/syntaxes/pike.tmLanguage.json");

  it("file exists", () => {
    expect(() => readFileSync(grammarPath, "utf8")).not.toThrow();
  });

  it("is valid JSON", () => {
    const content = readFileSync(grammarPath, "utf8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("has required top-level keys", () => {
    const grammar = JSON.parse(readFileSync(grammarPath, "utf8"));
    expect(grammar).toHaveProperty("scopeName");
    expect(grammar).toHaveProperty("patterns");
    expect(Array.isArray(grammar.patterns)).toBe(true);
  });

  it("has all primitive type keywords", () => {
    const grammar = JSON.parse(readFileSync(grammarPath, "utf8"));
    const allPatterns = collectPatterns(grammar);
    // Accept both support.type.primitive (old) and storage.type (new)
    const typePattern = allPatterns.find((p) =>
      p.name === "support.type.primitive" || p.name === "storage.type" || (p.name as string)?.startsWith("storage.type."),
    );
    expect(typePattern).toBeDefined();
    const match = typePattern!.match as string;
    expect(match).toBeDefined();
    for (const kw of ["mixed", "int", "float", "string", "array", "mapping", "multiset", "object", "program", "function", "type", "void", "zero"]) {
      expect(match).toContain(kw);
    }
  });

  it("has preprocessor directive pattern", () => {
    const grammar = JSON.parse(readFileSync(grammarPath, "utf8"));
    const allPatterns = collectPatterns(grammar);
    const preproc = allPatterns.find((p) => (p.name as string)?.includes("directive"));
    expect(preproc).toBeDefined();
    expect(preproc?.match).toBeDefined();
  });

  it("has modifier pattern", () => {
    const grammar = JSON.parse(readFileSync(grammarPath, "utf8"));
    const allPatterns = collectPatterns(grammar);
    const modifier = allPatterns.find((p) =>
      p.name === "storage.modifier" || (p.name as string)?.startsWith("storage.modifier."),
    );
    expect(modifier).toBeDefined();
    expect(modifier?.match).toBeDefined();
  });

  it("has declaration keywords (inherit, import)", () => {
    const grammar = JSON.parse(readFileSync(grammarPath, "utf8"));
    const allPatterns = collectPatterns(grammar);
    // Find pattern that matches inherit/import — could be in captures or direct match
    const declPattern = allPatterns.find((p) => {
      const name = p.name as string | undefined;
      if (name?.includes("declaration")) return true;
      // Also check captures (new grammar puts keyword in captures)
      const captures = p.captures as Record<string, { name?: string }> | undefined;
      if (captures) {
        for (const cap of Object.values(captures)) {
          if (cap.name?.includes("declaration")) return true;
        }
      }
      return false;
    });
    expect(declPattern).toBeDefined();
    // The pattern's match or the overall grammar must contain inherit/import
    const grammarText = JSON.stringify(grammar);
    expect(grammarText).toContain("inherit");
    expect(grammarText).toContain("import");
  });

  it("has AutoDoc comment pattern", () => {
    const grammar = JSON.parse(readFileSync(grammarPath, "utf8"));
    const allPatterns = collectPatterns(grammar);
    const docComment = allPatterns.find((p) =>
      (p.name as string)?.includes("comment") && (p.name as string)?.includes("documentation"),
    );
    expect(docComment).toBeDefined();
  });
});
