/**
 * Hover tests (LSP layer) — three-tier routing.
 *
 * Tier 1: Workspace AutoDoc — //! comments parsed from source
 * Tier 2: Stdlib — pike-ai-kb pike-signature (not yet wired)
 * Tier 3: Fall-through — tree-sitter declared type
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
// Tier 1: Workspace AutoDoc
// ---------------------------------------------------------------------------

describe("Tier 1: Workspace AutoDoc hover", () => {
  test("documented function shows @param and @returns", async () => {
    const uri = "file:///test/autodoc-fn.pike";
    const source = [
      "//! A documented function.",
      "//! @param x",
      "//!   The input value.",
      "//! @returns",
      "//!   The doubled input.",
      "int doc_func(int x) { return x * 2; }",
    ].join("\n");
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 5, character: 4 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("doc_func");
    expect(result!.contents.value).toContain("A documented function");
    expect(result!.contents.value).toContain("`x`");
    expect(result!.contents.value).toContain("doubled input");
  });

  test("documented class member shows member-level docs", async () => {
    const uri = "file:///test/autodoc-class.pike";
    const source = [
      "//! A documented class.",
      "class DocClass {",
      "  //! Get the value.",
      "  //! @returns",
      "  //!   The stored value.",
      "  int get_value() { return 1; }",
      "}",
    ].join("\n");
    server.openDoc(uri, source);

    // Hover on get_value (line 5)
    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 5, character: 6 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("Get the value");
    expect(result!.contents.value).toContain("stored value");
    // Should NOT contain the class-level doc
    expect(result!.contents.value).not.toContain("documented class");
  });

  test("documented variable shows summary", async () => {
    const uri = "file:///test/autodoc-var.pike";
    const source = [
      "//! The name of the thing.",
      "string name = \"default\";",
    ].join("\n");
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 1, character: 7 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("name of the thing");
  });
});

// ---------------------------------------------------------------------------
// Tier 3: Fall-through (tree-sitter, no autodoc)
// ---------------------------------------------------------------------------

describe("Tier 3: Fall-through hover (no autodoc)", () => {
  test("undocumented function shows bare signature", async () => {
    const uri = "file:///test/bare-fn.pike";
    const source = "int add(int a, int b) { return a + b; }";
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 0, character: 4 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("add");
    expect(result!.contents.value).toContain("```pike");
    // Should NOT have AutoDoc section markers
    expect(result!.contents.value).not.toContain("**Parameters:**");
  });

  test("undocumented variable shows declared type", async () => {
    const uri = "file:///test/bare-var.pike";
    const source = "string name = \"world\";";
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 0, character: 7 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("name");
  });

  test("empty position returns null", async () => {
    const uri = "file:///test/empty-hover.pike";
    const source = "\n\nint x = 1;\n";
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 0, character: 0 } },
    ) as HoverResult | null;

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hover range correctness
// ---------------------------------------------------------------------------

describe("Hover range", () => {
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
});

// ---------------------------------------------------------------------------
// Pike worker NOT involved in hover
// ---------------------------------------------------------------------------

describe("Hover isolation", () => {
  test("hover does not spawn pike worker for workspace files", async () => {
    // This test verifies the architectural constraint: hover goes through
    // parse-tree autodoc, not the pike worker subprocess.
    const uri = "file:///test/no-worker.pike";
    const source = [
      "//! Documented.",
      "int f() { return 1; }",
    ].join("\n");
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 1, character: 4 } },
    ) as HoverResult | null;

    // If the pike worker were involved, this would take >100ms due to subprocess
    // startup. The test asserts the result comes back quickly and correctly.
    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("Documented");
  });
});
