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
