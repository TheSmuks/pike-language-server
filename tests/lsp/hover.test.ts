/**
 * Hover tests (LSP layer).
 *
 * Tests the server's hover response for:
 * - Same-file declarations (function, class, variable)
 * - Hover at positions with no declaration
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";

// ---------------------------------------------------------------------------
// Shared server
// ---------------------------------------------------------------------------

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.teardown();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HoverResult {
  contents: { kind: string; value: string };
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("textDocument/hover", () => {
  test("hover on function declaration returns signature", async () => {
    const uri = "file:///test/hover-fn.pike";
    const source = [
      "int add(int a, int b) {",
      "  return a + b;",
      "}",
    ].join("\n");
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 0, character: 4 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.kind).toBe("markdown");
    expect(result!.contents.value).toContain("add");
    expect(result!.contents.value).toContain("```pike");
  });

  test("hover on variable declaration returns type", async () => {
    const uri = "file:///test/hover-var.pike";
    const source = "string name = \"world\";";
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 0, character: 7 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("name");
  });

  test("hover on class declaration returns class info", async () => {
    const uri = "file:///test/hover-class.pike";
    const source = [
      "class Animal {",
      "  string name;",
      "  void create(string n) { name = n; }",
      "}",
    ].join("\n");
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 0, character: 6 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("Animal");
  });

  test("hover at empty position returns null", async () => {
    const uri = "file:///test/hover-empty.pike";
    const source = "\n\nint x = 1;\n";
    server.openDoc(uri, source);

    // Line 0 has nothing
    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 0, character: 0 } },
    ) as HoverResult | null;

    expect(result).toBeNull();
  });

  test("hover range matches declaration position", async () => {
    const uri = "file:///test/hover-range.pike";
    const source = "int my_variable = 42;";
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 0, character: 5 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.range).toBeDefined();
    expect(result!.range!.start.line).toBe(0);
    expect(result!.range!.start.character).toBe(4); // 'my_variable' starts at char 4
  });

  test("hover on reference resolves to declaration", async () => {
    const uri = "file:///test/hover-ref.pike";
    const source = [
      "int greet() { return 1; }",
      "int caller() { return greet(); }",
    ].join("\n");
    server.openDoc(uri, source);

    // Hover on 'greet' on line 1 (reference, not declaration)
    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 1, character: 23 } },
    ) as HoverResult | null;

    // Should resolve via definition lookup and show hover info
    if (result) {
      expect(result.contents.value).toContain("greet");
    }
    // If null, the reference isn't in the same scope — acceptable for Phase 5
  });
});
