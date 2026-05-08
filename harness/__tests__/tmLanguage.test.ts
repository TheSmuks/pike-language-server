import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Verifies that pike.tmLanguage.json contains all required keyword captures.
 * This test performs JSON-level validation only — it does NOT tokenize Pike source.
 */
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
    const patterns = grammar.patterns as Array<{ name?: string; match?: string }>;
    const typePattern = patterns.find((p) => p.name === "support.type.primitive");
    expect(typePattern).toBeDefined();
    expect(typePattern?.match).toBeDefined();
    const match = typePattern!.match!;
    expect(match).toContain("(void|");
    for (const kw of ["mixed", "int", "float", "string", "array", "mapping", "multiset", "object", "program", "function", "type"]) {
      expect(match).toContain(`|${kw}|`);
    }
    expect(match).toContain("|zero)");
  });

  it("has preprocessor directive pattern", () => {
    const grammar = JSON.parse(readFileSync(grammarPath, "utf8"));
    const patterns = grammar.patterns as Array<{ name?: string; match?: string }>;
    const preproc = patterns.find((p) => p.name?.includes("directive"));
    expect(preproc).toBeDefined();
    expect(preproc?.match).toBeDefined();
  });

  it("has modifier pattern", () => {
    const grammar = JSON.parse(readFileSync(grammarPath, "utf8"));
    const patterns = grammar.patterns as Array<{ name?: string; match?: string }>;
    const modifier = patterns.find((p) => p.name === "storage.modifier");
    expect(modifier).toBeDefined();
    expect(modifier?.match).toBeDefined();
  });

  it("has declaration keywords (inherit, import)", () => {
    const grammar = JSON.parse(readFileSync(grammarPath, "utf8"));
    const patterns = grammar.patterns as Array<{ name?: string; match?: string }>;
    const decl = patterns.find((p) => p.name === "keyword.declaration");
    expect(decl).toBeDefined();
    const match = decl?.match ?? "";
    expect(match).toContain("|inherit|");
    expect(match).toContain("|import|");
  });

  it("has AutoDoc comment pattern", () => {
    const grammar = JSON.parse(readFileSync(grammarPath, "utf8"));
    const patterns = grammar.patterns as Array<{ name?: string; match?: string }>;
    const docComment = patterns.find((p) => p.name === "comment.line.documentation");
    expect(docComment).toBeDefined();
    expect(docComment?.match).toBeDefined();
  });
});
