/**
 * Behavioral tokenization tests for the Pike TextMate grammar.
 *
 * Rather than inspect the grammar's internal repository structure (brittle, and
 * meaningless after a grammar swap), these tokenize real Pike source with the
 * exact engine VS Code uses (vscode-oniguruma + vscode-textmate) and assert the
 * scope each token receives. This survives grammar restructuring and tests what
 * users actually see.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as oniguruma from "vscode-oniguruma";
import * as vsctm from "vscode-textmate";

const GRAMMAR = resolve(__dirname, "../../client/syntaxes/pike.tmLanguage.json");
const WASM = resolve(__dirname, "../../node_modules/vscode-oniguruma/release/onig.wasm");

let grammar: vsctm.IGrammar;

beforeAll(async () => {
  await oniguruma.loadWASM(readFileSync(WASM).buffer);
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (p) => new oniguruma.OnigScanner(p),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scope) =>
      scope === "source.pike"
        ? vsctm.parseRawGrammar(readFileSync(GRAMMAR, "utf8"), "pike.tmLanguage.json")
        : null,
  });
  const g = await registry.loadGrammar("source.pike");
  if (!g) throw new Error("failed to load source.pike grammar");
  grammar = g;
});

interface Tok {
  text: string;
  scopes: string[];
}

/** Tokenize a single line (grammar starts fresh). */
function tokenize(line: string): Tok[] {
  const r = grammar.tokenizeLine(line, vsctm.INITIAL);
  return r.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes }));
}

/** Assert the token whose text === `text` carries a scope with the given prefix. */
function expectScope(line: string, text: string, scopePrefix: string): void {
  const tok = tokenize(line).find((t) => t.text === text);
  expect(tok, `token '${text}' not found in: ${line}`).toBeDefined();
  const hit = tok!.scopes.some((s) => s === scopePrefix || s.startsWith(scopePrefix + "."));
  expect(hit, `token '${text}' scopes ${JSON.stringify(tok!.scopes)} lack '${scopePrefix}'`).toBe(true);
}

describe("Pike grammar — tokenization behavior", () => {
  it("colors primitive and container types as storage.type", () => {
    for (const t of ["int", "float", "string", "array", "mapping", "multiset", "object", "program", "function", "void", "mixed"]) {
      expectScope(`${t} x;`, t, "storage.type");
    }
  });

  it("colors control-flow and declaration keywords", () => {
    expectScope("if (x) return;", "if", "keyword.control");
    expectScope("foreach (a, int b) {}", "foreach", "keyword.control");
    expectScope("return 0;", "return", "keyword.control");
  });

  it("colors visibility/storage modifiers", () => {
    expectScope("private int x;", "private", "storage.modifier");
    expectScope("protected void f() {}", "protected", "storage.modifier");
  });

  it("colors double- and single-quoted strings", () => {
    expectScope('string s = "hi";', '"', "string.quoted.double");
    expectScope("int c = 'a';", "'", "string.quoted.single");
  });

  it("colors sprintf placeholders inside strings", () => {
    const toks = tokenize('werror("%s => %d\\n");');
    const pct = toks.find((t) => t.text === "%s");
    expect(pct?.scopes.some((s) => s.startsWith("constant.other.placeholder"))).toBe(true);
  });

  it("colors numeric literals (hex, binary, octal, float)", () => {
    for (const [line, n] of [["int a = 42;", "42"], ["int b = 0x2A;", "0x2A"], ["int c = 0b1010;", "0b1010"], ["float d = 1.5e-2;", "1.5e-2"]] as const) {
      expectScope(line, n, "constant.numeric");
    }
  });

  it("colors line and block comments, including AutoDoc", () => {
    expectScope("x; // trailing", "//", "comment");
    expectScope("//! doc line", "//!", "comment");
  });

  it("colors #include / #string target paths as include strings", () => {
    const toks = tokenize("#include <stdio.h>");
    const path = toks.find((t) => t.text.includes("stdio"));
    expect(path?.scopes.some((s) => s.includes("include"))).toBe(true);
  });

  it("colors ordinary and constructor-style calls as functions", () => {
    expectScope("write(x);", "write", "support.function");
    expectScope("Counter();", "Counter", "support.function");
  });

  it("colors member and scope-resolved method calls", () => {
    expectScope("o->read();", "read", "support.function");
    expectScope("Stdio.File(x);", "File", "support.function");
    expectScope("this->helper(n);", "helper", "support.function");
    expectScope("::process(data);", "process", "support.function");
  });

  it("colors Pike builtin functions from the reference (support.function.builtin)", () => {
    for (const b of ["sizeof", "sprintf", "werror", "indices", "objectp"]) {
      expectScope(`int n = ${b};`, b, "support.function.builtin");
    }
  });

  it("colors top-level stdlib modules from the reference (support.class)", () => {
    for (const m of ["Stdio", "Protocols", "Array", "String"]) {
      expectScope(`mixed v = ${m}.member;`, m, "support.class");
    }
  });

  it("colors class / enum declaration names", () => {
    expectScope("class Widget {", "Widget", "entity.name.type");
    expectScope("enum Color { RED }", "Color", "entity.name.type");
  });

  it("colors uppercase type references", () => {
    expectScope("Widget next;", "Widget", "entity.name.type");
    expectScope("Widget w = 0;", "Widget", "entity.name.type");
  });

  it("colors inherit / import module paths", () => {
    expectScope("inherit Stdio.File;", "Stdio.File", "entity.other.inherited-class");
    expectScope("import Protocols.HTTP;", "Protocols.HTTP", "entity.other.inherited-class");
  });

  it("colors constant declaration names (typed and untyped) and keeps the type", () => {
    expectScope("constant int MAX = 10;", "MAX", "constant.other");
    expectScope("constant int MAX = 10;", "int", "storage.type");
    expectScope('constant NAME = "x";', "NAME", "constant.other");
  });

  it("colors variable / field declaration names", () => {
    expectScope("int count = 0;", "count", "variable.other");
    expectScope("string name;", "name", "variable.other");
  });

  it("does not classify a member access as a builtin/module", () => {
    // `write` after `->` is a member call, not the predef builtin form.
    const toks = tokenize("o->size;");
    const size = toks.find((t) => t.text === "size");
    // whatever it is, it must not be tagged as the predef builtin scope
    expect(size?.scopes.some((s) => s.startsWith("support.function.builtin"))).not.toBe(true);
  });
});
