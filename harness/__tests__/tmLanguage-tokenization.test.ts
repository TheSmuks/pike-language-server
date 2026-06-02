import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface GrammarPattern {
  comment?: string;
  name?: string;
  match?: string;
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
});
