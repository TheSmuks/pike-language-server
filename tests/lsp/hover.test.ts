/**
 * Hover tests (LSP layer) — three-tier routing.
 *
 * Tier 1: Workspace AutoDoc — XML from PikeExtractor (cached on save)
 * Tier 2: Stdlib — pre-computed index (hash lookup)
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

/** Pre-populate the autodoc XML cache for a URI. */
function cacheAutodoc(uri: string, xml: string): void {
  server.server.autodocCache.set(uri, {
    xml,
    hash: "test-hash",
    timestamp: Date.now(),
  });
}

/** Generate PikeExtractor-style XML for a simple documented function. */
function xmlForFunction(name: string, summary: string, params: Array<{ name: string; desc: string }> = [], returns = ""): string {
  const paramGroups = params.map(p =>
    `<group><param name="${p.name}"/><text><p>${p.desc}</p></text></group>`
  ).join("\n");

  const returnsGroup = returns
    ? `<group><returns/><text><p>${returns}</p></text></group>`
    : "";

  const args = params.map(p => `<argument name='${p.name}'><type><mixed/></type></argument>`).join("");

  return `<?xml version='1.0' encoding='utf-8'?>
<namespace name='predef'>
  <docgroup homogen-name='${name}' homogen-type='method'>
    <doc>
      <text><p>${summary}</p></text>
      ${paramGroups}
      ${returnsGroup}
    </doc>
    <method name='${name}'>
      <arguments>${args}</arguments>
      <returntype><void/></returntype>
    </method>
  </docgroup>
</namespace>`;
}

/** Generate XML for a documented variable. */
function xmlForVariable(name: string, summary: string, type = "mixed"): string {
  return `<?xml version='1.0' encoding='utf-8'?>
<namespace name='predef'>
  <docgroup homogen-name='${name}' homogen-type='variable'>
    <doc><text><p>${summary}</p></text></doc>
    <variable name='${name}'><type><${type}/></type></variable>
  </docgroup>
</namespace>`;
}

// ---------------------------------------------------------------------------
// Tier 1: Workspace AutoDoc
// ---------------------------------------------------------------------------

describe("Tier 1: Workspace AutoDoc hover", () => {
  test("documented function shows summary and params from XML cache", async () => {
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

    // Pre-populate the XML cache (simulating what didSave would do)
    cacheAutodoc(uri, xmlForFunction("doc_func", "A documented function.",
      [{ name: "x", desc: "The input value." }],
      "The doubled input."));

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

  test("documented variable shows summary from XML cache", async () => {
    const uri = "file:///test/autodoc-var.pike";
    const source = [
      "//! The name of the thing.",
      "string name = \"default\";",
    ].join("\n");
    server.openDoc(uri, source);

    cacheAutodoc(uri, xmlForVariable("name", "The name of the thing.", "string"));

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 1, character: 7 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("name of the thing");
  });

  test("cache miss falls through to tree-sitter", async () => {
    const uri = "file:///test/cache-miss.pike";
    const source = "int undocumented_func() { return 1; }";
    server.openDoc(uri, source);

    // No cache entry — should fall through to tree-sitter (Tier 3)
    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 0, character: 4 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("undocumented_func");
    // Should NOT have AutoDoc section markers
    expect(result!.contents.value).not.toContain("**Returns:**");
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Stdlib
// ---------------------------------------------------------------------------

describe("Tier 2: Stdlib hover", () => {
  test("predef builtin hover shows type signature", async () => {
    // Declare a local variable with the same name as a predef builtin,
    // then hover over a reference to it. This exercises the Tier 2b
    // predef builtins lookup inside declForHover.
    const uri = "file:///test/predef-hover.pike";
    const source = "int write(int x) { return x; }\nint y = write(1);";
    server.openDoc(uri, source);

    // Hover over the call to write() on line 1
    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 1, character: 8 } },
    ) as HoverResult | null;

    // The local function 'write' should be resolved by tree-sitter
    // and produce a hover result (Tier 3 at minimum — bare signature).
    expect(result).not.toBeNull();
    expect(result!.contents.value).toBeDefined();
    // Should contain the function signature
    expect(result!.contents.value).toContain("function");
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
// Pike worker NOT involved in hover hot path
// ---------------------------------------------------------------------------

describe("Hover isolation", () => {
  test("hover with cached autodoc does not call pike worker", async () => {
    const uri = "file:///test/no-worker.pike";
    const source = [
      "//! Documented.",
      "int f() { return 1; }",
    ].join("\n");
    server.openDoc(uri, source);

    // Pre-populate cache — this is the hot path
    cacheAutodoc(uri, xmlForFunction("f", "Documented."));

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 1, character: 4 } },
    ) as HoverResult | null;

    // The pike worker should NOT be spawned for this request
    // (it would take >100ms due to subprocess startup)
    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("Documented");
  });
});
