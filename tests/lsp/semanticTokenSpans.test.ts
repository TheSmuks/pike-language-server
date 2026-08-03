/**
 * Regression: a semantic token must span an identifier, and no span twice.
 *
 * Semantic tokens override TextMate scopes in VSCode, so a token that covers
 * punctuation repaints that punctuation as part of a name. The client also
 * advertises overlappingTokenSupport=false, so duplicate spans are not merely
 * redundant — they are outside the protocol the client agreed to.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable } from "../../server/src/features/symbolTable";
import { produceSemanticTokens } from "../../server/src/features/semanticTokens";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function tokensFor(src: string) {
  const table = buildSymbolTable(parse(src)!, "file:///t.pike", 1, undefined, src);
  return { tokens: produceSemanticTokens(table), lines: src.split("\n") };
}

describe("semantic token spans", () => {
  beforeAll(async () => { await initParser(); });

  const SOURCES: Array<[string, string]> = [
    ["enum members and a this_object() call", `enum Colour { RED, GREEN }

class Builder {
  object self_ref() { return this_object(); }
  string own() { return sprintf("%O", this_program); }
}

int main() {
  Colour c = RED;
  return c;
}
`],
    ["a dotted inherit path", `inherit Sql.sql_result;

class Inner { int v; }
int main() { return 0; }
`],
    ["inherit through a string literal", `inherit "other.pike";

int main() { return 0; }
`],
  ];

  for (const [label, src] of SOURCES) {
    test(`every token covers a bare identifier — ${label}`, () => {
      const { tokens, lines } = tokensFor(src);
      for (const t of tokens) {
        const text = lines[t.line]?.slice(t.character, t.character + t.length);
        expect(text, `token at ${t.line}:${t.character}:${t.length}`).toMatch(IDENTIFIER);
      }
    });

    test(`no span is emitted twice — ${label}`, () => {
      const { tokens } = tokensFor(src);
      const keys = tokens.map(t => `${t.line}:${t.character}:${t.length}`);
      expect(keys.length).toBe(new Set(keys).size);
    });

    test(`no two tokens overlap — ${label}`, () => {
      const { tokens } = tokensFor(src);
      const sorted = [...tokens].sort(
        (a, b) => a.line - b.line || a.character - b.character,
      );
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        if (prev.line !== cur.line) continue;
        expect(prev.character + prev.length,
          `token ${prev.line}:${prev.character} overlaps ${cur.line}:${cur.character}`)
          .toBeLessThanOrEqual(cur.character);
      }
    });
  }

  test("this_object() is coloured without its call parentheses", () => {
    const { tokens, lines } = tokensFor(`class B {
  object self() { return this_object(); }
}
`);
    const line = lines.findIndex(l => l.includes("this_object()"));
    const at = lines[line].indexOf("this_object");
    const token = tokens.find(t => t.line === line && t.character === at);
    if (token) expect(token.length).toBe("this_object".length);
  });

  test("a dotted inherit path does not swallow the separator", () => {
    const { tokens, lines } = tokensFor(`inherit Sql.sql_result;\nint main() { return 0; }\n`);
    for (const t of tokens) {
      const text = lines[t.line]?.slice(t.character, t.character + t.length);
      expect(text).not.toContain(".");
    }
  });
});
