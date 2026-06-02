import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface GrammarPattern {
  comment?: string;
  name?: string;
  match?: string;
  captures?: Record<string, { name?: string }>;
  patterns?: GrammarPattern[];
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

function patternByName(grammar: Grammar, repositoryName: string, patternName: string): GrammarPattern | undefined {
  return repositoryPatterns(grammar, repositoryName).find((pattern) => pattern.name === patternName);
}

function patternByCommentPrefix(
  grammar: Grammar,
  repositoryName: string,
  commentPrefix: string,
): GrammarPattern | undefined {
  return repositoryPatterns(grammar, repositoryName).find((pattern) => pattern.comment?.startsWith(commentPrefix));
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

  it("matches Pike 8.0 BNF numeric literal forms", () => {
    const grammar = loadGrammar();
    const numericPatterns = repositoryPatterns(grammar, "numbers").filter(
      (pattern) => pattern.name === "constant.numeric.pike",
    );
    const floatPattern = patternByName(grammar, "numbers", "constant.numeric.float.pike");

    expect(numericPatterns.length).toBeGreaterThan(0);
    expect(floatPattern?.match).toBeDefined();

    const numericRegexes = numericPatterns.map((pattern) => new RegExp(pattern.match!, "u"));
    const floatRegex = new RegExp(floatPattern!.match!, "u");

    for (const literal of ["42", "0x2a", "0X2A", "0b101010", "0B101010", "0755"]) {
      expect(numericRegexes.some((regex) => literal.match(regex)?.[0] === literal)).toBe(true);
    }
    for (const literal of ["1.5", "1.5e-2", ".5", "5e10"]) {
      expect(literal.match(floatRegex)?.[0]).toBe(literal);
    }
  });

  it("matches Pike 8.0 BNF string and character escape forms", () => {
    const grammar = loadGrammar();
    const doubleQuoted = patternByName(grammar, "strings", "string.quoted.double.pike");
    const singleQuoted = patternByName(grammar, "strings", "string.quoted.single.pike");

    const doubleEscapes = doubleQuoted?.patterns ?? [];
    const singleEscapes = singleQuoted?.patterns ?? [];

    const escapedSamples = ["\\a", "\\b", "\\t", "\\n", "\\v", "\\f", "\\r", "\\\"", "\\\\", "\\123", "\\x2a", "\\d42", "\\u0041", "\\U00000041"];
    for (const escaped of escapedSamples) {
      expect(doubleEscapes.some((pattern) => new RegExp(pattern.match!, "u").test(escaped))).toBe(true);
      expect(singleEscapes.some((pattern) => new RegExp(pattern.match!, "u").test(escaped))).toBe(true);
    }
  });

  it("matches Pike 8.0 BNF operator-name identifiers", () => {
    const grammar = loadGrammar();
    const backtickPattern = patternByName(grammar, "identifiers", "entity.name.function.operator.pike");
    expect(backtickPattern?.match).toBeDefined();

    const regex = new RegExp(backtickPattern!.match!, "u");
    for (const identifier of ["`+", "`/", "`%", "`*", "`&", "`|", "`^", "`~", "`<", "`<<", "`<=", "`>", "`>>", "`>=", "`==", "`!=", "`!", "`()", "`-", "`->", "`->=", "`[]", "`[]="]) {
      expect(identifier.match(regex)?.[0]).toBe(identifier);
    }
  });

  it("does not classify aggregate literal delimiters as a TextMate scope", () => {
    // Per ADR-0029, aggregate-literal delimiters ({, }, <, >, [, ] in
    // aggregate contexts) are classified by the tree-sitter semantic-token
    // layer, not the TextMate grammar. PR #95's `literal-delimiters` rule
    // produced false positives like `])` in `foo(arr[i])` because regex has
    // no parse context. The rule has been removed; this test enforces that
    // it does not reappear.
    const grammar = loadGrammar();
    const repo = grammar.repository ?? {};
    expect(repo).not.toHaveProperty("literal-delimiters");

    const allPatterns: { name?: string; match?: string }[] = [];
    for (const entry of Object.values(repo)) {
      const patterns = Array.isArray(entry) ? entry : entry.patterns ?? [];
      for (const p of patterns) allPatterns.push(p as { name?: string; match?: string });
    }
    // No rule should match the `([` / `])` / `({` / `})` / `(<` / `>)` token
    // pairs at the start of an aggregate literal. None of these should be
    // a single TextMate match.
    for (const sample of ["foo(arr[i])", "f(g(x[i]))", "({ 1, 2 })", "([ \"k\": v ])", "({})", "([])"]) {
      for (const pat of allPatterns) {
        if (!pat.match) continue;
        const re = new RegExp(pat.match, "gu");
        const matches = [...sample.matchAll(re)].map(m => m[0]);
        // `])` and `])` and `]))` and similar substrings must not be a
        // match. The `])` from `foo(arr[i])` is the canonical PR #95
        // regression.
        expect(matches).not.toContain("])");
        expect(matches).not.toContain("])");
      }
    }
  });

  it("matches Pike 8.0 BNF assignment, spread, splice, and range operators", () => {
    const grammar = loadGrammar();
    const operatorPattern = patternByCommentPrefix(grammar, "operators", "Operators");
    expect(operatorPattern?.match).toBeDefined();

    const regex = new RegExp(operatorPattern!.match!, "u");
    for (const operator of ["=", "+=", "*=", "/=", "&=", "|=", "^=", "<<=", ">>=", "%=", "..", "...", "@", "->"] ) {
      expect(operator.match(regex)?.[0]).toBe(operator);
    }
  });
});
