/**
 * Document highlight tests (US-015).
 *
 * Tests textDocument/documentHighlight via LSP protocol.
 * Verifies read/write highlighting for variables, functions, classes, parameters, and enum members.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";

interface HighlightResult {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  kind?: number; // 1=Read, 2=Write
}

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.teardown();
});

describe("US-015: textDocument/documentHighlight", () => {
  test("highlights variable read and write (declaration)", async () => {
    const src = [
      "int main() {",
      "  int count = 42;",
      "  return count;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/highlight-var.pike", src);

    // Hover on 'count' at line 2, char 9 (read reference)
    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 2, character: 9 },
    }) as HighlightResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThanOrEqual(2); // declaration (Write) + reference (Read)

    // One should be Write (the declaration at line 1)
    const writes = result!.filter(h => h.kind === 3);
    expect(writes.length).toBeGreaterThanOrEqual(1);

    // One should be Read (the reference at line 2)
    const reads = result!.filter(h => h.kind === 2);
    expect(reads.length).toBeGreaterThanOrEqual(1);
  });

  test("highlights function calls and definition", async () => {
    const src = [
      "int add(int a, int b) { return a + b; }",
      "int main() {",
      "  int result = add(1, 2);",
      "  return result;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/highlight-fn.pike", src);

    // Hover on 'add' at line 2, char 15 (call reference)
    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 2, character: 15 },
    }) as HighlightResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThanOrEqual(2); // definition + call
  });

  test("highlights class usage", async () => {
    const src = [
      "class Dog { void speak() {} }",
      "int main() {",
      "  Dog d = Dog();",
      "  d->speak();",
      "  return 0;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/highlight-class.pike", src);

    // Hover on 'Dog' at line 0, char 6 (class declaration)
    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 0, character: 6 },
    }) as HighlightResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThanOrEqual(1);
  });

  test("highlights parameter usages", async () => {
    const src = [
      "int add(int a, int b) {",
      "  return a + b;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/highlight-param.pike", src);

    // Hover on 'a' at line 1, char 9 (reference)
    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 1, character: 9 },
    }) as HighlightResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThanOrEqual(2); // declaration (param) + reference
  });

  test("returns null for unknown document", async () => {
    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri: "file:///nonexistent.pike" },
      position: { line: 0, character: 0 },
    });

    expect(result).toBeNull();
  });

  test("highlights a declaration that has no other references (N1)", async () => {
    // Audit iteration 7, finding N1: a symbol occurring exactly once got null.
    // The declaration IS an occurrence — LSP asks for all highlights at the
    // position, and rust-analyzer, gopls and tsserver all highlight a lone
    // declaration. 4,242 instances across the Roxen tree and the corpus.
    const src = [
      "int main() {",
      "  return 0;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/highlight-lonely.pike", src);

    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 0, character: 4 }, // 'main', declared once, never called
    }) as HighlightResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].kind).toBe(3); // Write — it is the declaration
    expect(result![0].range.start).toEqual({ line: 0, character: 4 });
  });

  test("a lone declaration highlight does not duplicate itself", async () => {
    // The declaration is pushed first and then skipped in the ref loop; with
    // no refs there is nothing to skip, so guard against an off-by-one that
    // would emit the same range twice.
    const src = "int solitary;\n";
    const uri = server.openDoc("file:///test/highlight-solitary.pike", src);

    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 0, character: 4 },
    }) as HighlightResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
  });

  test("resolves the inherit qualifier in A::member() (N2/N3/C1/C2 cluster)", async () => {
    // Audit iteration 7: definition, declaration, references, hover, completion
    // and documentHighlight ALL returned null on the `A` in `A::value()`.
    // collectScopeRef recorded a reference only for the member after `::`,
    // reading the qualifier solely to resolve that member — so nothing existed
    // at the qualifier's position for any feature to find.
    const src = [
      "class A {",
      "  int value() { return 1; }",
      "}",
      "class C {",
      "  inherit A;",
      "  int sum() { return A::value(); }",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/scope-qualifier.pike", src);

    // Cursor on the `A` qualifier at line 5, char 21.
    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 5, character: 21 },
    }) as HighlightResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThanOrEqual(1);
  });

  test("highlights a member accessed through a receiver declared in an outer scope", async () => {
    // Audit iteration 7: documentHighlight returned null on `obj->member` while
    // definition resolved it fine. The member reference is only resolved if the
    // RECEIVER can be found, and that lookup used findDeclInScope, which checks
    // the given scope and its inherited scopes but never walks PARENT scopes —
    // so a field declared on the class was invisible from inside a method body.
    const src = [
      "class Item {",
      "  void configure(int v) { }",
      "}",
      "class Holder {",
      "  Item single;",
      "  void go() {",
      "    single->configure(1);",
      "    single->configure(2);",
      "  }",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/highlight-member.pike", src);

    // Cursor on `configure` in the first call.
    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 6, character: 14 },
    }) as HighlightResult[] | null;

    expect(result).not.toBeNull();
    // Both call sites must be highlighted, not just the one under the cursor.
    const lines = result!.map(h => h.range.start.line).sort();
    expect(lines).toContain(6);
    expect(lines).toContain(7);
  });

  test("returns null for position with no symbol", async () => {
    const src = "int main() { return 0; }";
    const uri = server.openDoc("file:///test/highlight-empty.pike", src);

    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 0, character: 0 }, // 'i' of 'int', not a symbol
    });

    expect(result).toBeNull();
  });
});
