import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface GrammarPattern {
  comment?: string;
  name?: string;
  match?: string;
  captures?: Record<string, { name?: string }>;
}

interface GrammarRepositoryEntry {
  patterns?: GrammarPattern[];
}

interface Grammar {
  repository?: Record<string, GrammarRepositoryEntry>;
}

function loadGrammar(): Grammar {
  const grammarPath = resolve(__dirname, "../../client/syntaxes/pike.tmLanguage.json");
  return JSON.parse(readFileSync(grammarPath, "utf8")) as Grammar;
}

function identifierPatterns(grammar: Grammar): GrammarPattern[] {
  const patterns = grammar.repository?.identifiers?.patterns;
  if (!patterns) return [];
  return patterns;
}

function functionCallPatternIndex(patterns: GrammarPattern[]): number {
  return patterns.findIndex((pattern) => pattern.name === "entity.name.function.call.pike");
}

function catchAllIdentifierPatternIndex(patterns: GrammarPattern[]): number {
  return patterns.findIndex((pattern) => pattern.name === "variable.other.pike");
}

function classReferencePatternIndex(patterns: GrammarPattern[]): number {
  return patterns.findIndex((pattern) => pattern.name === "entity.name.type.class.pike");
}

function repositoryPatterns(grammar: Grammar, name: string): GrammarPattern[] {
  const patterns = grammar.repository?.[name]?.patterns;
  if (!patterns) return [];
  return patterns;
}

describe("pike.tmLanguage.json tokenization rules", () => {
  it("classifies call identifiers before the generic identifier fallback", () => {
    const patterns = identifierPatterns(loadGrammar());

    const callIndex = functionCallPatternIndex(patterns);
    const catchAllIndex = catchAllIdentifierPatternIndex(patterns);

    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(catchAllIndex).toBeGreaterThanOrEqual(0);
    expect(callIndex).toBeLessThan(catchAllIndex);
  });

  it("matches ordinary function and constructor-style calls", () => {
    const patterns = identifierPatterns(loadGrammar());
    const callPattern = patterns[functionCallPatternIndex(patterns)];
    expect(callPattern?.match).toBeDefined();

    const regex = new RegExp(callPattern.match!, "u");
    expect("write(\"hello\");".match(regex)?.[0]).toBe("write");
    expect("Foo();".match(regex)?.[0]).toBe("Foo");
  });

  it("classifies class-like identifiers before the generic identifier fallback", () => {
    const patterns = identifierPatterns(loadGrammar());

    const classIndex = classReferencePatternIndex(patterns);
    const catchAllIndex = catchAllIdentifierPatternIndex(patterns);

    expect(classIndex).toBeGreaterThanOrEqual(0);
    expect(catchAllIndex).toBeGreaterThanOrEqual(0);
    expect(classIndex).toBeLessThan(catchAllIndex);
  });

  it("matches class-like identifiers as type/class tokens", () => {
    const patterns = identifierPatterns(loadGrammar());
    const classPattern = patterns[classReferencePatternIndex(patterns)];
    expect(classPattern?.match).toBeDefined();

    const regex = new RegExp(classPattern.match!, "u");
    expect("Foo value;".match(regex)?.[0]).toBe("Foo");
    expect("Stdio.File file;".match(regex)?.[0]).toBe("Stdio");
    expect("lowercase value;".match(regex)?.[0]).toBeUndefined();
  });

  it("maps arrow member names to the standard property scope", () => {
    const patterns = repositoryPatterns(loadGrammar(), "member-access");
    const arrowPattern = patterns.find((pattern) => pattern.comment?.startsWith("Arrow member access"));

    expect(arrowPattern?.captures?.["1"]?.name).toBe("punctuation.accessor.arrow.pike");
    expect(arrowPattern?.captures?.["2"]?.name).toBe("variable.other.property.pike");
  });
});
