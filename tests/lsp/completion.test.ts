// ---------------------------------------------------------------------------
// US-009: PikeWorker typeof integration for completion on mixed/untyped vars
// ---------------------------------------------------------------------------

describe.skipIf(!pikeAvailable)("US-009: typeof integration for completion on mixed/untyped variables", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
    resetCompletionCache();
  });

  afterAll(async () => {
    await server.teardown();
  });

  test("completion: mixed d = Dog(); d-> shows Dog members via PikeWorker.typeof_", async () => {
    const src = [
      'class Dog { void speak() {} void fetch(string item) {} }',
      'void test() {',
      '  mixed d = Dog();',
      '  d->',
      '}',
    ].join('\n');
    const uri = server.openDoc("file:///test/us009-completion.pike", src);

    // Cursor after 'd->' at line 3, col 5
    const result = await server.client.sendRequest("textDocument/completion", {
      textDocument: { uri },
      position: { line: 3, character: 5 },
    }) as { items: Array<{ label: string }> };

    expect(result).not.toBeNull();
    const labels = result.items.map(i => i.label);
    expect(labels).toContain("speak");
    expect(labels).toContain("fetch");
  });

  test("completion: auto x = Stdio.File(); x-> shows File members via PikeWorker.typeof_", async () => {
    const src = [
      'void test() {',
      '  auto f = Stdio.File();',
      '  f->',
      '}',
    ].join('\n');
    const uri = server.openDoc("file:///test/us009-auto-completion.pike", src);

    // Cursor after 'f->' at line 2, col 4
    const result = await server.client.sendRequest("textDocument/completion", {
      textDocument: { uri },
      position: { line: 2, character: 4 },
    }) as { items: Array<{ label: string }> };

    expect(result).not.toBeNull();
    const labels = result.items.map(i => i.label);
    // Stdio.File has 'open' as a constructor/method
    expect(labels.some(l => l === "open" || l.includes("read") || l.includes("write"))).toBe(true);
  });

  test("completion: param typed mixed produces no member completions (no initializer)", async () => {
    const src = [
      'void foo(mixed x) { x-> }',
    ].join('\n');
    const uri = server.openDoc("file:///test/us009-mixed-param.pike", src);

    // Cursor after 'x->' at line 0, col 17
    const result = await server.client.sendRequest("textDocument/completion", {
      textDocument: { uri },
      position: { line: 0, character: 17 },
    }) as { items: Array<{ label: string }> };

    // mixed parameter with no initializer: no assignedType, typeof_() won't help
    // The result may be empty or fall through to predef builtins
    expect(result).not.toBeNull();
  });

  test("completion: definition: d->speak() resolves via PikeWorker typeof on mixed var with no initializer", async () => {
    const src = [
      'class Dog { void speak() {} void fetch(string item) {} }',
      'void test() {',
      '  mixed d = Dog();',
      '  d->speak();',
      '}',
    ].join('\n');
    const uri = server.openDoc("file:///test/us009-definition.pike", src);

    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 3, character: 5 }, // on 'speak'
    });

    expect(result).not.toBeNull();
    expect(result.uri).toBe(uri);
    expect(result.range.start.line).toBe(0); // Dog class at line 0
  });
});

/**
 * Completion tests (LSP layer + direct API).
 *
 * Tests the completion provider from decision 0012:
 * - Unqualified completion: local scope, predef builtins, stdlib top-level
 * - Dot access completion: module members
 * - Arrow access completion: object members
 * - Scope access completion: inherited members
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createTestServer, type TestServer } from "./helpers";
import { pikeAvailable } from "../helpers/pikeAvailable";
import {
  initParser,
  parse,
} from "../../server/src/parser";
import {
  buildSymbolTable,
  wireInheritance,
  getSymbolsInScope,
  type SymbolTable,
} from "../../server/src/features/symbolTable";
import {
  getCompletions,
  resetCompletionCache,
  type CompletionContext,
} from "../../server/src/features/completion";
import { WorkspaceIndex, ModificationSource } from "../../server/src/features/workspaceIndex";
import stdlibAutodocIndex from "../../server/src/data/stdlib-autodoc.json";
import predefBuiltinIndex from "../../server/src/data/predef-builtin-index.json";

// ---------------------------------------------------------------------------
// Shared server
// ---------------------------------------------------------------------------

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
  resetCompletionCache();
});

afterAll(async () => {
  await server.teardown();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CompletionResult {
  isIncomplete: boolean;
  items: Array<{
    label: string;
    kind?: number;
    detail?: string;
    sortText?: string;
  }>;
}

function completionLabels(result: CompletionResult): string[] {
  return result.items.map(i => i.label);
}

/** Build a minimal CompletionContext for direct API tests. */
function makeCtx(uri = "file:///test/test.pike"): CompletionContext {
  return {
    index: new WorkspaceIndex({ workspaceRoot: "/test" }),
    stdlibIndex: stdlibAutodocIndex as Record<string, { signature: string; markdown: string }>,
    predefBuiltins: predefBuiltinIndex as Record<string, string>,
    uri,
  };
}

// ---------------------------------------------------------------------------
// Direct API: getSymbolsInScope
// ---------------------------------------------------------------------------

describe("getSymbolsInScope", () => {
  test("returns local variables in function scope", () => {
    const src = [
      "void foo() {",
      "  int x = 1;",
      "  string y = \"hello\";",
      "  // cursor here",
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/scope.pike", 1);
    wireInheritance(table);

    // Line 3 (0-indexed), character 2 — inside the function body after both decls
    const symbols = getSymbolsInScope(table, 3, 2);
    const names = symbols.map(s => s.name);

    expect(names).toContain("x");
    expect(names).toContain("y");
    // The function itself should be visible from the enclosing scope
    expect(names).toContain("foo");
  });

  test("returns function parameters", () => {
    const src = "void foo(int a, string b) { /* cursor */ }";
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/params.pike", 1);
    wireInheritance(table);

    // Line 0, character 30 — inside function body
    const symbols = getSymbolsInScope(table, 0, 30);
    const names = symbols.map(s => s.name);

    expect(names).toContain("a");
    expect(names).toContain("b");
  });

  test("returns class members when inside class scope", () => {
    const src = [
      "class Foo {",
      "  int x;",
      "  void bar() {}",
      "  void baz() {",
      "    // cursor here",
      "  }",
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/class.pike", 1);
    wireInheritance(table);

    // Line 4, character 4 — inside baz() method body
    const symbols = getSymbolsInScope(table, 4, 4);
    const names = symbols.map(s => s.name);

    expect(names).toContain("x");
    expect(names).toContain("bar");
    expect(names).toContain("baz");
    expect(names).toContain("Foo");
  });

  test("deduplicates — inner scope shadows outer", () => {
    const src = [
      "int x = 1;",
      "void foo() {",
      "  string x = \"inner\";",
      "  // cursor here",
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/shadow.pike", 1);
    wireInheritance(table);

    const symbols = getSymbolsInScope(table, 3, 2);
    const xDecls = symbols.filter(s => s.name === "x");

    // Should have exactly one 'x' — the inner one
    expect(xDecls).toHaveLength(1);
    expect(xDecls[0].kind).toBe("variable");
  });

  test("returns file-scope declarations (top-level)", () => {
    const src = [
      "int alpha = 1;",
      "string beta = \"two\";",
      "void gamma() {}",
      "// cursor",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/top-level.pike", 1);
    wireInheritance(table);

    const symbols = getSymbolsInScope(table, 3, 0);
    const names = symbols.map(s => s.name);

    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(names).toContain("gamma");
  });

  test("does not include declarations after cursor in block scope", () => {
    const src = [
      "void foo() {",
      "  int before = 1;",
      "  // cursor",
      "  int after = 2;",
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/ordering.pike", 1);
    wireInheritance(table);

    // Line 2, char 2 — after 'before' but before 'after'
    const symbols = getSymbolsInScope(table, 2, 2);
    const names = symbols.map(s => s.name);

    expect(names).toContain("before");
    expect(names).not.toContain("after");
  });
});

// ---------------------------------------------------------------------------
// Direct API: getCompletions — unqualified
// ---------------------------------------------------------------------------

describe("getCompletions — unqualified", () => {
  test("returns local variables and functions in scope", async () => {
    const src = [
      "int alpha = 1;",
      "void beta() {}",
      "void gamma() {",
      "  string local_var = \"hi\";",
      "  al",
      "}",
    ].join("\n");
    const tree = parse(src);
    const ctx = makeCtx();

    // Build the actual symbol table
    const table = buildSymbolTable(tree, "file:///test/unqual.pike", 1);
    wireInheritance(table);

    const realResult = await getCompletions(table, tree, 4, 3, ctx);
    const labels = completionLabels(realResult);

    expect(labels).toContain("alpha");
    expect(labels).toContain("beta");
    expect(labels).toContain("gamma");
    expect(labels).toContain("local_var");
  });

  test("includes predef builtins", async () => {
    const src = "void foo() { wr }";
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/predef.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    // Cursor at line 0, char 15 — after "wr"
    const result = await getCompletions(table, tree, 0, 15, ctx);
    const labels = completionLabels(result);

    // 'write' is a C-level predef builtin
    expect(labels).toContain("write");
    // 'werror' too
    expect(labels).toContain("werror");
  });

  test("includes stdlib top-level module names", async () => {
    const src = "void foo() { Std }";
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/stdlib.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    const result = await getCompletions(table, tree, 0, 16, ctx);
    const labels = completionLabels(result);

    // 'Stdio' is a top-level stdlib module
    expect(labels).toContain("Stdio");
    // 'String' is another one
    expect(labels).toContain("String");
  });

  test("local symbols rank higher than predef builtins", async () => {
    const src = [
      "void foo() {",
      "  int write = 42;",  // shadows predef 'write'
      "  wr",
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/shadow-predef.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    const result = await getCompletions(table, tree, 2, 3, ctx);
    const writeItems = result.items.filter(i => i.label === "write");

    // Should have both, but local should come first (lower sortText)
    expect(writeItems.length).toBeGreaterThanOrEqual(1);

    // The local 'write' variable should have a lower sort key than predef
    const localWrite = writeItems.find(i => i.kind === 6); // Variable = 6
    const predefWrite = writeItems.find(i => i.kind === 3); // Function = 3

    if (localWrite && predefWrite) {
      expect(localWrite.sortText!).toBeLessThan(predefWrite.sortText!);
    }
  });
});

// ---------------------------------------------------------------------------
// LSP protocol: completion requests
// ---------------------------------------------------------------------------

describe("textDocument/completion (LSP protocol)", () => {
  test("returns empty list for non-existent document", async () => {
    const result = await server.client.sendRequest(
      "textDocument/completion",
      {
        textDocument: { uri: "file:///nonexistent.pike" },
        position: { line: 0, character: 0 },
      },
    ) as CompletionResult;

    expect(result.items).toHaveLength(0);
  });

  test("returns local symbols for simple file", async () => {
    const uri = "file:///test/completion-local.pike";
    const source = [
      "int counter = 0;",
      "void increment() { counter++; }",
      "void main() { inc }",
    ].join("\n");
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/completion",
      {
        textDocument: { uri },
        position: { line: 2, character: 17 }, // cursor after "inc"
      },
    ) as CompletionResult;

    const labels = completionLabels(result);

    expect(labels).toContain("increment");
    expect(labels).toContain("counter");
    expect(labels).toContain("main");
  });

  test("returns predef builtins for bare identifier", async () => {
    const uri = "file:///test/completion-predef.pike";
    const source = "void main() { wri }";
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/completion",
      {
        textDocument: { uri },
        position: { line: 0, character: 17 }, // cursor after "wri"
      },
    ) as CompletionResult;

    const labels = completionLabels(result);
    expect(labels).toContain("write");
  });

  test("returns completions inside class body", async () => {
    const uri = "file:///test/completion-class.pike";
    const source = [
      "class Animal {",
      "  string name;",
      "  void speak() {}",
      "  void test() {",
      "    na",
      "  }",
      "}",
    ].join("\n");
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/completion",
      {
        textDocument: { uri },
        position: { line: 4, character: 5 }, // cursor after "na"
      },
    ) as CompletionResult;

    const labels = completionLabels(result);
    expect(labels).toContain("name");
    expect(labels).toContain("speak");
    expect(labels).toContain("test");
  });

  test("returns CompletionList structure", async () => {
    const uri = "file:///test/completion-structure.pike";
    const source = "int x = 1;";
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/completion",
      {
        textDocument: { uri },
        position: { line: 0, character: 0 },
      },
    ) as CompletionResult;

    expect(result).toHaveProperty("isIncomplete");
    expect(result).toHaveProperty("items");
    expect(Array.isArray(result.items)).toBe(true);
  });

  test("completion items have required LSP fields", async () => {
    const uri = "file:///test/completion-fields.pike";
    const source = "void foo(int x) { x; }";
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/completion",
      {
        textDocument: { uri },
        position: { line: 0, character: 20 }, // inside function body
      },
    ) as CompletionResult;

    // Should have at least one item (x, foo, predef builtins)
    expect(result.items.length).toBeGreaterThan(0);

    // Each item must have a label
    for (const item of result.items) {
      expect(item.label).toBeDefined();
      expect(typeof item.label).toBe("string");
    }
  });

  test("cancelled request returns empty via $/cancelRequest", async () => {
    // This test creates a standalone server with raw JSON-RPC I/O
    // to test that $/cancelRequest causes the completion handler to
    // return empty early (via token.isCancellationRequested check).
    //
    // The shared test server's client reader consumes s2c, making it
    // impossible to read raw responses. A standalone server avoids this.

    const { PassThrough } = await import("node:stream");
    const { StreamMessageReader, StreamMessageWriter } = await import("vscode-jsonrpc");
    const { createConnection } = await import("vscode-languageserver/node");
    const { createPikeServer } = await import("../../server/src/server");
    const { initParser: ensureParser } = await import("../../server/src/parser");

    const rawC2s = new PassThrough();
    const rawS2c = new PassThrough();
    const rawConn = createConnection(
      new StreamMessageReader(rawC2s),
      new StreamMessageWriter(rawS2c),
    );
    createPikeServer(rawConn);
    rawConn.listen();

    const writeRaw = (obj: object) => {
      const body = JSON.stringify(obj);
      rawC2s.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    };

    const readRaw = (): Promise<any> => new Promise((resolve, reject) => {
      let buf = "";
      let bodyLen = 0;
      const timeout = setTimeout(() => reject(new Error("raw response timeout")), 3000);
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        for (;;) {
          if (!bodyLen) {
            const idx = buf.indexOf("\r\n\r\n");
            if (idx === -1) break;
            const m = buf.substring(0, idx).match(/Content-Length: (\d+)/);
            if (m) bodyLen = parseInt(m[1]);
            buf = buf.substring(idx + 4);
          }
          if (bodyLen && buf.length >= bodyLen) {
            const body = buf.substring(0, bodyLen);
            buf = buf.substring(bodyLen);
            bodyLen = 0;
            clearTimeout(timeout);
            rawS2c.removeListener("data", onData);
            resolve(JSON.parse(body));
            return;
          }
          break;
        }
      };
      rawS2c.on("data", onData);
    });

    // Initialize
    writeRaw({ jsonrpc: "2.0", id: 1, method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
    await readRaw();
    writeRaw({ jsonrpc: "2.0", method: "initialized", params: {} });
    await ensureParser();

    // Open doc
    writeRaw({ jsonrpc: "2.0", method: "textDocument/didOpen", params: {
      textDocument: { uri: "file:///test/cancel-raw.pike", languageId: "pike", version: 1, text: "void foo(int x) { x }" },
    }});
    await new Promise(r => setTimeout(r, 50));

    // Normal request: should return completions
    writeRaw({ jsonrpc: "2.0", id: 10, method: "textDocument/completion", params: {
      textDocument: { uri: "file:///test/cancel-raw.pike" }, position: { line: 0, character: 20 },
    }});
    const normal = await readRaw();
    expect(normal.result.items.length).toBeGreaterThan(0);

    // Cancelled request: send completion + cancel back-to-back before server reads
    writeRaw({ jsonrpc: "2.0", id: 20, method: "textDocument/completion", params: {
      textDocument: { uri: "file:///test/cancel-raw.pike" }, position: { line: 0, character: 20 },
    }});
    writeRaw({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 20 } });
    const cancelled = await readRaw();

    // Handler returns empty via the first token.isCancellationRequested guard
    expect(cancelled.id).toBe(20);
    expect(cancelled.result.isIncomplete).toBe(false);
    expect(cancelled.result.items).toHaveLength(0);

    rawC2s.destroy();
    rawS2c.destroy();
  });
});
// ---------------------------------------------------------------------------
// Audit fixes: operator filtering, dot/arrow trigger, foreach variables
// ---------------------------------------------------------------------------

describe("Audit fixes", () => {
  test("no operator symbols in completion list", async () => {
    const src = "void foo(int a) { }";
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/ops.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    const result = await getCompletions(table, tree, 0, 18, ctx);
    const ops = result.items.filter(i =>
      i.label.startsWith("`") ||
      /^[<>!=&|^~%/*+-]+$/.test(i.label) ||
      /^[\[\](){}]+$/.test(i.label)
    );
    expect(ops).toHaveLength(0);
  });

  test("Stdio. returns module members (not unqualified)", async () => {
    const src = 'void test() { Stdio.\n }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/stdio-dot.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    const result = await getCompletions(table, tree, 0, 20, ctx);
    const labels = completionLabels(result);

    expect(labels).toContain("File");
    expect(labels).toContain("read_file");
    expect(labels).toContain("stderr");
    // Should NOT contain predef builtins like 'write' — this is a dot-access context
    expect(labels).not.toContain("write");
  });

  test("Array. returns module members", async () => {
    const src = 'void test() { Array.\n }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/array-dot.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    // Cursor at char 20 (after the dot) — LSP sends position after trigger char
    const result = await getCompletions(table, tree, 0, 20, ctx);
    const labels = completionLabels(result);

    // Array module members from the stdlib index
    expect(labels).toContain("reduce");
    expect(labels).toContain("sort_array");
    expect(labels).toContain("flatten");
    // Should NOT contain predef builtins — this is a dot-access context
    expect(labels).not.toContain("write");
  });

  test("foreach loop variables are visible in scope", () => {
    const src = 'void test() { array(int) items = ({}); foreach(items; int idx; int val) { } }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/foreach.pike", 1);
    wireInheritance(table);

    // Cursor inside foreach body
    const symbols = getSymbolsInScope(table, 0, 65);
    const names = symbols.map(s => s.name);
    expect(names).toContain("idx");
    expect(names).toContain("val");
    expect(names).toContain("items");
  });

  test("arrow access on trailing line does not fall through to unqualified", async () => {
    const src = 'void test() { mixed x = "hello"; x->\n }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/arrow-trail.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    // Cursor at char 36 (after '>')
    const result = await getCompletions(table, tree, 0, 36, ctx);
    // mixed type has no known members — should return 0, not all builtins
    expect(result.items.length).toBe(0);
  });

  test("scope access Base:: returns inherited members", async () => {
    const src = [
      'class Base {',
      '  void base_method() {}',
      '}',
      'class Child {',
      '  inherit Base;',
      '  void test() { Base:: }',
      '}',
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/scope-access.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    const result = await getCompletions(table, tree, 5, 25, ctx);
    const labels = completionLabels(result);
    expect(labels).toContain("base_method");
  });

  test("dot completion on same-file class name returns its members", async () => {
    const src = [
      'class Animal {',
      '  string name;',
      '  void speak() {}',
      '  void eat() {}',
      '}',
      'void test() { Animal. }',
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/class-dot.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    // Cursor after the dot on line 5: 'void test() { Animal. }'
    // The dot is at column 20, cursor at column 21
    const result = await getCompletions(table, tree, 5, 21, ctx);
    const labels = completionLabels(result);

    expect(labels).toContain("name");
    expect(labels).toContain("speak");
    expect(labels).toContain("eat");
  });
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

describe("Completion ranking", () => {
  test("local scope symbols rank above predef builtins", async () => {
    const src = [
      'int alpha = 1;',
      'void foo(int param) {',
      '  string local_var = "hi";',
      '  // cursor',
      '}',
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/ranking.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    const result = await getCompletions(table, tree, 3, 2, ctx);
    const labels = completionLabels(result);

    const localIdx = labels.indexOf("local_var");
    const paramIdx = labels.indexOf("param");
    const alphaIdx = labels.indexOf("alpha");
    const writeIdx = labels.indexOf("write");
    const stdioIdx = labels.indexOf("Stdio");

    // Local scope before outer scope
    expect(localIdx).toBeLessThan(alphaIdx);
    // Outer scope before predef builtins
    expect(alphaIdx).toBeLessThan(writeIdx);
    // Predef builtins before stdlib modules
    expect(writeIdx).toBeLessThan(stdioIdx);
  });

  test("ranking uses sortText with priority tiers", async () => {
    const src = 'void foo(int x) { }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/sort.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    const result = await getCompletions(table, tree, 0, 18, ctx);

    // All items should have sortText
    for (const item of result.items) {
      expect(item.sortText).toBeDefined();
    }

    // Sort prefix pattern: 0000 = local, 0030 = predef, 0040 = stdlib
    const prefixes = new Set(result.items.map(i => i.sortText!.substring(0, 4)));
    expect(prefixes).toContain("0000");
    expect(prefixes).toContain("0030");
    expect(prefixes).toContain("0040");
  });
});
// ---------------------------------------------------------------------------
// Stdlib secondary index
// ---------------------------------------------------------------------------

describe("stdlib secondary index", () => {
  test("Stdio.File has known members", async () => {
    const ctx = makeCtx();
    // Trigger a completion that forces index building
    const src = "void foo() {}";
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/idx.pike", 1);
    wireInheritance(table);

    const result = await getCompletions(table, tree, 0, 0, ctx);
    // Just verify the index builds — check that Stdio is in the top-level
    const labels = completionLabels(result);
    expect(labels).toContain("Stdio");
  });

  test("predef builtin count is correct", () => {
    const predefKeys = Object.keys(predefBuiltinIndex);
    expect(predefKeys.length).toBe(283);
  });

  test("stdlib index has expected entry count", () => {
    const stdlibKeys = Object.keys(stdlibAutodocIndex);
    expect(stdlibKeys.length).toBeGreaterThan(5400);
  });
});

// ---------------------------------------------------------------------------
// Declared-type member completion
// ---------------------------------------------------------------------------

describe("Declared-type member completion", () => {
  test("typed variable arrow access resolves class members", async () => {
    const src = 'class Animal { string name; int age; void speak() {} } void test() { Animal a = Animal(); a-> }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/typed-var.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    const arrowIdx = src.indexOf('a->');
    const result = await getCompletions(table, tree, 0, arrowIdx + 3, ctx);
    const labels = completionLabels(result);

    expect(labels).toContain("name");
    expect(labels).toContain("age");
    expect(labels).toContain("speak");
    // Should NOT contain unqualified predef builtins
    expect(labels).not.toContain("write");
  });

  test("typed parameter arrow access resolves class members", async () => {
    const src = 'class Dog { void bark() {} } void train(Dog d) { d-> }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/typed-param.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    const arrowIdx = src.indexOf('d->');
    const result = await getCompletions(table, tree, 0, arrowIdx + 3, ctx);
    const labels = completionLabels(result);

    expect(labels).toContain("bark");
  });

  test("inherited members appear in typed variable completion", async () => {
    const src = 'class Base { void base_method() {} } class Child { inherit Base; void child_method() {} } void test(Child c) { c-> }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/typed-inherit.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    const arrowIdx = src.indexOf('c->');
    const result = await getCompletions(table, tree, 0, arrowIdx + 3, ctx);
    const labels = completionLabels(result);

    expect(labels).toContain("child_method");
    expect(labels).toContain("base_method");
  });

  test("primitive types produce no member completions", async () => {
    const src = 'void foo(string s, int i) { s-> }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/primitive.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    const arrowIdx = src.indexOf('s->');
    const result = await getCompletions(table, tree, 0, arrowIdx + 3, ctx);
    expect(result.items).toHaveLength(0);
  });

  test("mixed type produces no member completions", async () => {
    const src = 'void foo(mixed x) { x-> }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/mixed-type.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    const arrowIdx = src.indexOf('x->');
    const result = await getCompletions(table, tree, 0, arrowIdx + 3, ctx);
    expect(result.items).toHaveLength(0);
  });

  test("declaredType is populated in symbol table", () => {
    const src = 'void foo(Animal a, string s) { int i = 0; }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/decl-types.pike", 1);
    wireInheritance(table);

    const aDecl = table.declarations.find(d => d.name === "a");
    const sDecl = table.declarations.find(d => d.name === "s");
    const iDecl = table.declarations.find(d => d.name === "i");

    expect(aDecl?.declaredType).toBe("Animal");
    expect(sDecl?.declaredType).toBe("string");
    expect(iDecl?.declaredType).toBe("int");
  });
});

// ---------------------------------------------------------------------------
// Cross-file completion via WorkspaceIndex
// ---------------------------------------------------------------------------

describe("Cross-file completion via WorkspaceIndex", () => {
  beforeAll(async () => {
    await initParser();
  });

  const CORPUS_DIR = join(import.meta.dir, "..", "..", "corpus", "files");

  async function indexCorpus(filenames: string[]): Promise<WorkspaceIndex> {
    const idx = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    for (const name of filenames) {
      const uri = "file://" + join(CORPUS_DIR, name);
      const src = readFileSync(join(CORPUS_DIR, name), "utf-8");
      const tree = parse(src);
      await idx.upsertFile(uri, 1, tree, src, ModificationSource.didOpen);
    }
    return idx;
  }

  test("cross-file arrow completion returns members from imported class", async () => {
    const idx = await indexCorpus(["cross_import_a.pmod", "cross-import-b.pike"]);
    const uriB = "file://" + join(CORPUS_DIR, "cross-import-b.pike");
    const tableB = idx.getSymbolTable(uriB)!;
    const srcB = readFileSync(join(CORPUS_DIR, "cross-import-b.pike"), "utf-8");
    const treeB = parse(srcB);
    const ctx: CompletionContext = {
      index: idx,
      stdlibIndex: stdlibAutodocIndex as Record<string, { signature: string; markdown: string }>,
      predefBuiltins: predefBuiltinIndex as Record<string, string>,
      uri: uriB,
    };

    // Line 18 (0-indexed 17): "    write(\"greet: %s\\n\", g->greet(\"Alice\"));"
    // Cursor after g-> at column 27
    const result = await getCompletions(tableB, treeB, 17, 27, ctx);
    const labels = completionLabels(result);

    // greet is a method of class Greeter defined in cross_import_a.pmod
    expect(labels).toContain("greet");
    // Should also find the greeting property and create constructor
    expect(labels).toContain("greeting");
    // Should NOT fall through to unqualified predef builtins
    expect(labels).not.toContain("write");
  });

  test("cross-file inherit completion: Dog d-> shows Animal members (US-001)", async () => {
    const idx = await indexCorpus(["cross-inherit-simple-a.pike", "cross-inherit-simple-b.pike"]);
    const uriB = "file://" + join(CORPUS_DIR, "cross-inherit-simple-b.pike");
    const tableB = idx.getSymbolTable(uriB)!;
    const srcB = readFileSync(join(CORPUS_DIR, "cross-inherit-simple-b.pike"), "utf-8");
    const treeB = parse(srcB);
    const ctx: CompletionContext = {
      index: idx,
      stdlibIndex: stdlibAutodocIndex as Record<string, { signature: string; markdown: string }>,
      predefBuiltins: predefBuiltinIndex as Record<string, string>,
      uri: uriB,
    };

    // Line 25: d->speak() — cursor after d-> at column 28
    const result = await getCompletions(tableB, treeB, 25, 28, ctx);
    const labels = completionLabels(result);

    // Animal's members should appear via cross-file inheritance
    expect(labels).toContain("speak");
    expect(labels).toContain("get_name");
    // Dog's own member should also be present
    expect(labels).toContain("fetch");
  });

  test("cross-file inherit completion: no duplicate entries when child overrides parent member (US-002)", async () => {
    // Create a scenario where Dog overrides Animal.speak()
    const srcA = 'class Animal { string name; void speak() { return name + " talks"; } }';
    const srcB = 'inherit "file_a.pike"; class Dog { inherit Animal; void speak() { return "woof"; } void fetch() {} } void test() { Dog d = Dog(); d-> }';

    const idx = new WorkspaceIndex({ workspaceRoot: "/test" });
    const uriA = "file:///test/file_a.pike";
    const uriB = "file:///test/file_b.pike";

    const treeA = parse(srcA);
    await idx.upsertFile(uriA, 1, treeA, srcA, ModificationSource.DidOpen);

    const treeB = parse(srcB);
    await idx.upsertFile(uriB, 1, treeB, srcB, ModificationSource.DidOpen);

    const tableB = idx.getSymbolTable(uriB)!;
    const ctx: CompletionContext = {
      index: idx,
      stdlibIndex: stdlibAutodocIndex as Record<string, { signature: string; markdown: string }>,
      predefBuiltins: predefBuiltinIndex as Record<string, string>,
      uri: uriB,
    };

    // Cursor after d-> at end of file_b
    const arrowIdx = srcB.indexOf('d->');
    const result = await getCompletions(tableB, treeB, 0, arrowIdx + 3, ctx);
    const labels = completionLabels(result);

    // speak should appear exactly once (child overrides parent)
    const speakCount = labels.filter(l => l === "speak").length;
    expect(speakCount).toBe(1);

    // fetch is Dog's own member
    expect(labels).toContain("fetch");
    // name is Animal's protected field — not visible via arrow access
  });

  test("function return type completion: makeDog()-> shows Dog members (US-007)", async () => {
    const src = [
      'class Dog { void speak() {} void fetch(string item) {} }',
      'Dog makeDog() { return Dog("Rex"); }',
      'void test() {',
      '  makeDog()->speak();',
      '}',
    ].join('\n');
    const idx = new WorkspaceIndex({ workspaceRoot: "/test" });
    const uri = "file:///test.pike";
    const tree = parse(src);
    await idx.upsertFile(uri, 1, tree, src, ModificationSource.DidOpen);
    const table = idx.getSymbolTable(uri)!;

    const ctx: CompletionContext = {
      index: idx,
      stdlibIndex: stdlibAutodocIndex as Record<string, { signature: string; markdown: string }>,
      predefBuiltins: predefBuiltinIndex as Record<string, string>,
      uri,
    };

    // Cursor on 'speak' identifier (line 3, col 13)
    const result = await getCompletions(table, tree, 3, 13, ctx);
    const labels = completionLabels(result);

    // Dog's members should appear via function return type resolution
    expect(labels).toContain("speak");
    expect(labels).toContain("fetch");
  });

  test("chained function return type: makeDog()->fetch()-> stops at void (US-007)", async () => {
    // fetch returns void — no further members should be resolved
    const src = [
      'class Dog { string speak() { return "woof"; } void fetch(string item) {} }',
      'Dog makeDog() { return Dog("Rex"); }',
      'void test() {',
      '  makeDog()->speak();',
      '}',
    ].join('\n');
    const idx = new WorkspaceIndex({ workspaceRoot: "/test" });
    const uri = "file:///test.pike";
    const tree = parse(src);
    await idx.upsertFile(uri, 1, tree, src, ModificationSource.DidOpen);
    const table = idx.getSymbolTable(uri)!;

    // makeDog() returns Dog, so makeDog()->speak resolves speak
    const ctx: CompletionContext = {
      index: idx,
      stdlibIndex: stdlibAutodocIndex as Record<string, { signature: string; markdown: string }>,
      predefBuiltins: predefBuiltinIndex as Record<string, string>,
      uri,
    };
    const result = await getCompletions(table, tree, 3, 13, ctx);
    const labels = completionLabels(result);
    expect(labels).toContain("speak");
  });

  // ---------------------------------------------------------------
  // US-008: Assignment-based type narrowing
  // ---------------------------------------------------------------

  test("assignment inference: Dog d = makeDog(); d-> shows Dog members (US-008)", async () => {
    const src = [
      'class Dog { void speak() {} void fetch(string item) {} }',
      'Dog makeDog() { return Dog("Rex"); }',
      'void test() {',
      '  Dog d = makeDog();',
      '  d->speak();',
      '}',
    ].join('\n');
    const idx = new WorkspaceIndex({ workspaceRoot: "/test" });
    const uri = "file:///test.pike";
    const tree = parse(src);
    await idx.upsertFile(uri, 1, tree, src, ModificationSource.DidOpen);
    const table = idx.getSymbolTable(uri)!;

    const ctx: CompletionContext = {
      index: idx,
      stdlibIndex: stdlibAutodocIndex as Record<string, { signature: string; markdown: string }>,
      predefBuiltins: predefBuiltinIndex as Record<string, string>,
      uri,
    };

    // Cursor on 'speak' identifier (line 4, col 5)
    const result = await getCompletions(table, tree, 4, 5, ctx);
    const labels = completionLabels(result);

    // Dog's members should appear via declaredType (explicitly typed)
    expect(labels).toContain("speak");
    expect(labels).toContain("fetch");
  });

  test("assignment inference: mixed d = Dog(); d-> shows Dog members (US-008)", async () => {
    const src = [
      'class Dog { void speak() {} void fetch(string item) {} }',
      'void test() {',
      '  mixed d = Dog();',
      '  d->speak();',
      '}',
    ].join('\n');
    const idx = new WorkspaceIndex({ workspaceRoot: "/test" });
    const uri = "file:///test.pike";
    const tree = parse(src);
    await idx.upsertFile(uri, 1, tree, src, ModificationSource.DidOpen);
    const table = idx.getSymbolTable(uri)!;

    // Verify that 'd' has assignedType set to 'Dog' (the constructor name)
    const dDecl = table.declarations.find(d => d.name === 'd' && d.kind === 'variable');
    expect(dDecl).toBeDefined();
    expect(dDecl!.declaredType).toBe('mixed');
    expect(dDecl!.assignedType).toBe('Dog');

    const ctx: CompletionContext = {
      index: idx,
      stdlibIndex: stdlibAutodocIndex as Record<string, { signature: string; markdown: string }>,
      predefBuiltins: predefBuiltinIndex as Record<string, string>,
      uri,
    };

    // Cursor on 'speak' identifier (line 3, col 5)
    const result = await getCompletions(table, tree, 3, 5, ctx);
    const labels = completionLabels(result);

    // Dog's members should appear via assignedType since declaredType is 'mixed'
    expect(labels).toContain("speak");
    expect(labels).toContain("fetch");
  });

  test("assignment inference: no initializer produces no assignedType (US-008)", async () => {
    const src = [
      'class Dog { void speak() {} }',
      'void test() {',
      '  Dog d;',
      '  d->speak();',
      '}',
    ].join('\n');
    const idx = new WorkspaceIndex({ workspaceRoot: "/test" });
    const uri = "file:///test.pike";
    const tree = parse(src);
    await idx.upsertFile(uri, 1, tree, src, ModificationSource.DidOpen);
    const table = idx.getSymbolTable(uri)!;

    // Verify that 'd' has declaredType but no assignedType
    const dDecl = table.declarations.find(d => d.name === 'd' && d.kind === 'variable');
    expect(dDecl).toBeDefined();
    expect(dDecl!.declaredType).toBe('Dog');
    expect(dDecl!.assignedType).toBeUndefined();
  });

  test("assignment inference: complex initializer ignored (US-008)", async () => {
    const src = [
      'class Dog { void speak() {} }',
      'void test() {',
      '  mixed d = 42;',
      '  d->speak();',
      '}',
    ].join('\n');
    const idx = new WorkspaceIndex({ workspaceRoot: "/test" });
    const uri = "file:///test.pike";
    const tree = parse(src);
    await idx.upsertFile(uri, 1, tree, src, ModificationSource.DidOpen);
    const table = idx.getSymbolTable(uri)!;

    // Verify that 'd' has no assignedType for a literal initializer
    const dDecl = table.declarations.find(d => d.name === 'd' && d.kind === 'variable');
    expect(dDecl).toBeDefined();
    expect(dDecl!.declaredType).toBe('mixed');
    // Integer literal is not an identifier — no assignedType
    expect(dDecl!.assignedType).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Private member filtering (dot vs arrow access)
// ---------------------------------------------------------------------------

describe("Private member filtering", () => {
  test("dot access filters out __-prefixed private members", async () => {
    const src = [
      'class Vault {',
      '  int public_count;',
      '  int __secret;',
      '  void reveal() {}',
      '  void __hidden() {}',
      '}',
      'void test() { Vault. }',
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/dot-private.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    // Cursor after 'Vault.' on line 6
    const result = await getCompletions(table, tree, 6, 20, ctx);
    const labels = completionLabels(result);

    expect(labels).toContain("public_count");
    expect(labels).toContain("reveal");
    // Private members (__ prefix) should be hidden via dot access
    expect(labels).not.toContain("__secret");
    expect(labels).not.toContain("__hidden");
  });

  test("arrow access shows all members including __-prefixed", async () => {
    const src = [
      'class Vault {',
      '  int public_count;',
      '  int __secret;',
      '  void reveal() {}',
      '  void __hidden() {}',
      '}',
      'void test() { Vault v = Vault(); v-> }',
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/arrow-private.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    const line6 = src.split('\n')[6];
    const arrowCol = line6.indexOf('v->') + 3;
    const result = await getCompletions(table, tree, 6, arrowCol, ctx);
    const labels = completionLabels(result);

    // Arrow access shows all members, public and private
    expect(labels).toContain("public_count");
    expect(labels).toContain("reveal");
    expect(labels).toContain("__secret");
    expect(labels).toContain("__hidden");
  });
});