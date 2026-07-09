import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Structural sanity checks for pike.tmLanguage.json. Behavioral coverage (what
 * scope each construct actually gets) lives in tmLanguage-tokenization.test.ts,
 * which tokenizes real Pike with the vscode-textmate engine. Here we only assert
 * the manifest-level invariants that don't depend on grammar internals.
 */

describe("pike.tmLanguage.json", () => {
  const grammarPath = resolve(__dirname, "../../client/syntaxes/pike.tmLanguage.json");
  const packagePath = resolve(__dirname, "../../package.json");

  function loadGrammar(): Record<string, unknown> {
    return JSON.parse(readFileSync(grammarPath, "utf8"));
  }

  it("file exists and is valid JSON", () => {
    expect(() => loadGrammar()).not.toThrow();
  });

  it("declares the source.pike scope and Pike file types", () => {
    const g = loadGrammar();
    expect(g.scopeName).toBe("source.pike");
    expect(Array.isArray(g.patterns)).toBe(true);
    expect(g.repository).toBeDefined();
    const fileTypes = g.fileTypes as string[] | undefined;
    expect(fileTypes).toContain("pike");
    expect(fileTypes).toContain("pmod");
  });

  it("credits the grammar's origin (attribution)", () => {
    const info = loadGrammar().information_for_contributors as string[] | undefined;
    expect(Array.isArray(info)).toBe(true);
    expect(info!.join(" ")).toContain("pike-for-sublime");
  });

  it("includes the Pike-reference expansion (builtins + modules)", () => {
    const repo = loadGrammar().repository as Record<string, { patterns?: Array<{ name?: string; match?: string }> }>;
    const builtins = repo["builtin-functions"]?.patterns?.[0];
    const modules = repo["builtin-modules"]?.patterns?.[0];
    expect(builtins?.name).toBe("support.function.builtin.pike");
    expect(modules?.name).toBe("support.class.pike");
    // A few known reference names must be present in the generated alternations.
    expect(builtins?.match).toContain("sizeof");
    expect(builtins?.match).toContain("werror");
    expect(modules?.match).toContain("Stdio");
    expect(modules?.match).toContain("Protocols");
  });

  it("maps semantic token types to TextMate fallback scopes for opt-in semantic highlighting", () => {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    const pikeScopes = packageJson.contributes?.semanticTokenScopes?.find(
      (entry: { language?: string }) => entry.language === "pike",
    )?.scopes;

    expect(pikeScopes?.function).toContain("support.function.any-method.pike");
    expect(pikeScopes?.method).toContain("support.function.any-method.pike");
    expect(pikeScopes?.builtinFunction).toContain("support.function.builtin.pike");
  });
});
