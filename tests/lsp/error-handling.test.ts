/**
 * LSP protocol-level tests for error handling.
 *
 * Verifies the server behaves gracefully under malformed input,
 * missing documents, syntax errors, and edge cases.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";

// ---------------------------------------------------------------------------
// Shared server — one instance for all tests, torn down once at the end
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

function generateLargeSource(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(`string fn_${i}() { return "${i}"; }`);
  }
  return lines.join("\n");
}

function nextDiagnostics(
  client: TestServer["client"],
  uri: string,
  timeoutMs = 3000,
): Promise<{ diagnostics: unknown[] }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("publishDiagnostics timeout")),
      timeoutMs,
    );
    const disposable = client.onNotification(
      { method: "textDocument/publishDiagnostics" as const },
      (params: { uri: string; diagnostics: unknown[] }) => {
        if (params.uri === uri) {
          clearTimeout(timer);
          disposable.dispose();
          resolve(params);
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("error handling", () => {
  test("malformed request: missing params returns error response", async () => {
    // textDocument/documentSymbol with empty params — the server should
    // return an error or empty result, not crash
    const result = await server.client.sendRequest(
      "textDocument/documentSymbol",
      { textDocument: {} },
    );
    // Empty textDocument.uri → documents.get returns undefined → server returns []
    expect(Array.isArray(result as unknown)).toBe(true);
  });

  test("non-existent file URI returns empty array", async () => {
    const result = await server.client.sendRequest(
      "textDocument/documentSymbol",
      {
        textDocument: { uri: "file:///nonexistent/path/missing.pike" },
      },
    );
    expect(result).toEqual([]);
  });

  test("syntax error file returns partial symbols and diagnostics", async () => {
    const uri = "file:///test/syntax-error.pike";
    const source = [
      "int x = 1;",
      "string y = \"hello\";",
      "// valid declarations above, error below",
      "class Broken {",
      "  void create() {",
      "    // missing closing brace",
      "",
    ].join("\n");

    server.openDoc(uri, source);

    // Wait for diagnostics from didChange
    const diagResult = await nextDiagnostics(server.client, uri);
    expect(diagResult.diagnostics.length).toBeGreaterThan(0);

    // Request documentSymbol — should get partial results
    const symbols = (await server.client.sendRequest(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    )) as unknown[];

    expect(Array.isArray(symbols)).toBe(true);
    // Should have at least the valid declarations from the top
    expect(symbols.length).toBeGreaterThan(0);
  });

  test("empty file returns empty symbols", async () => {
    const uri = "file:///test/empty.pike";
    server.openDoc(uri, "");

    const result = await server.client.sendRequest(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    );
    expect(result).toEqual([]);
  });

  test("large file (200 declarations) returns results", async () => {
    const uri = "file:///test/large.pike";
    const source = generateLargeSource(200);
    server.openDoc(uri, source);

    const result = (await server.client.sendRequest(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    )) as unknown[];

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(200);
  });

  test("concurrent requests all get responses", async () => {
    const uri1 = "file:///test/concurrent1.pike";
    const uri2 = "file:///test/concurrent2.pike";
    const uri3 = "file:///test/concurrent3.pike";

    server.openDoc(uri1, "int a = 1;");
    server.openDoc(uri2, "string b() { return \"hi\"; }");
    server.openDoc(uri3, "class C {}");

    const [r1, r2, r3] = await Promise.all([
      server.client.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri: uri1 },
      }),
      server.client.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri: uri2 },
      }),
      server.client.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri: uri3 },
      }),
    ]);

    expect(Array.isArray(r1 as unknown)).toBe(true);
    expect(Array.isArray(r2 as unknown)).toBe(true);
    expect(Array.isArray(r3 as unknown)).toBe(true);
  });

  test("invalid URI scheme returns empty array", async () => {
    // HTTP URI was never opened, so documents.get returns undefined → []
    const result = await server.client.sendRequest(
      "textDocument/documentSymbol",
      {
        textDocument: { uri: "http://example.com/test.pike" },
      },
    );
    expect(result).toEqual([]);
  });

  test("KL-007-style broken file: partial recovery", async () => {
    const uri = "file:///test/kl007.pike";
    // Mimics the kind of parse errors tree-sitter produces on KL-007 files
    const source = [
      "int valid_var = 42;",
      "string valid_fn() { return \"ok\"; }",
      "",
      "}}}} broken",
      "",
    ].join("\n");

    server.openDoc(uri, source);

    const diagResult = await nextDiagnostics(server.client, uri);
    expect(diagResult.diagnostics.length).toBeGreaterThan(0);

    const symbols = (await server.client.sendRequest(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    )) as unknown[];

    expect(Array.isArray(symbols)).toBe(true);
    // Should recover at least valid_var from the valid portion
    const names = (symbols as Array<{ name: string }>).map((s) => s.name);
    expect(names).toContain("valid_var");
  });

  test("Unicode in source: non-ASCII in string literals round-trips via JSON-RPC", async () => {
    const uri = "file:///test/unicode-strings.pike";
    const source = 'string msg = "naïve résumé with café";\n';
    server.openDoc(uri, source);

    const symbols = (await server.client.sendRequest(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    )) as unknown[];

    // JSON-RPC transport handles UTF-8 correctly. Tree-sitter parses the
    // string literal (including non-ASCII) and extracts the variable.
    expect(Array.isArray(symbols)).toBe(true);
    expect(symbols.length).toBeGreaterThan(0);
    // The variable name is ASCII — only the string value contains Unicode.
    // Verify the symbol name came through the JSON-RPC round-trip intact.
    const sym = symbols[0] as { name: string; range: { start: { line: number } } };
    expect(sym.name).toBe("msg");
  });

  test("Unicode identifier: non-ASCII names parse correctly and round-trip via JSON-RPC", async () => {
    // UTF-8 identifiers are now supported by tree-sitter-pike (fix for issue #1).
    // Verify the full Unicode identifier round-trips through JSON-RPC.
    const uri = "file:///test/unicode-ident.pike";
    const source = "string café = \"value\";\n";
    server.openDoc(uri, source);

    const symbols = (await server.client.sendRequest(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    )) as unknown[];

    expect(Array.isArray(symbols)).toBe(true);
    expect(symbols.length).toBeGreaterThan(0);
    const sym = symbols[0] as { name: string };
    expect(sym.name).toBe("café");
  });

  test("didChange with empty content does not crash server", async () => {
    // Regression test: open a valid Pike file, then send didChange with empty
    // string content.  The server's onDidChangeContent handler has a content guard
    // `if (!content && content !== "")` that returns early on undefined/null
    // while still allowing empty string (falsy but !== "" is false → continues).
    const uri = "file:///test/empty-change.pike";
    const validSource = "int x = 1;\n";

    server.openDoc(uri, validSource);

    // Ensure the document is indexed before the change
    const beforeSymbols = (await server.client.sendRequest(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    )) as unknown[];
    expect(beforeSymbols.length).toBeGreaterThan(0);

    // Send didChange with empty string — exercises the server content guard
    server.client.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "" }],
    });

    // The server should not crash — documentSymbol returns whatever the server
    // produces (empty content may still produce a token, not a crash).
    const result = (await server.client.sendRequest(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    )) as unknown[];
    expect(Array.isArray(result)).toBe(true);
    // The key assertion is no crash — the server is resilient to empty content.

    // Restore valid content so subsequent tests are not affected
    server.client.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 3 },
      contentChanges: [{ text: validSource }],
    });

    const restoredSymbols = (await server.client.sendRequest(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    )) as unknown[];
    expect(restoredSymbols.length).toBeGreaterThan(0);
  });


  test("didOpen with empty content does not crash autodoc extraction", async () => {
    // Regression test: navigationHandler onDidOpen calls computeContentHash(source)
    // where source = doc.getText().  The content guard `if (!source && source !== "")`
    // prevents crashes when source is undefined.  Empty string is allowed (guard
    // passes because `"" !== ""` is false).
    const uri = "file:///test/empty-on-open.pike";

    // Open with empty content — exercises the navigation content guard.
    // The server should not crash from the autodoc pipeline.
    server.openDoc(uri, "");

    // The key assertion: no crash when opening empty content.
    // Subsequent request should still work.
    const result = (await server.client.sendRequest(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    )) as unknown[];
    expect(Array.isArray(result)).toBe(true);
  });

  test(".pmod file opens and indexes without crashing", async () => {
    // Regression test: .pmod files triggered a crash in the navigation handler's
    // onDidOpen because computeContentHash was called with source that could be
    // falsy (undefined), and source.charAt(0) throws TypeError on undefined.
    // The content guard prevents this.
    const uri = "file:///test/Geom/Point.pmod";
    const source = [
      "// AutoDoc module header",
      "!=\"Point — a 2D coordinate.\"",
      "",
      "class Point {",
      "  //! X coordinate",
      "  int x;",
      "  //! Y coordinate",
      "  int y;",
      "",
      "  //! Construct a Point",
      "  void create(int _x, int _y) {",
      "    x = _x;",
      "    y = _y;",
      "  }",
      "",
      "  //! Distance from origin",
      "  float magnitude() {",
      "    return sqrt((float)(x * x + y * y));",
      "  }",
      "}",
      "",
    ].join("\n");

    server.openDoc(uri, source);

    const symbols = (await server.client.sendRequest(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    )) as unknown[];

    expect(Array.isArray(symbols)).toBe(true);
    // The key assertion: server did not crash on .pmod file.
    // It may or may not produce symbols depending on tree-sitter's .pmod support.
    // If symbols were produced, verify the class name appears.
    const names = (symbols as Array<{ name: string }>).map((s) => s.name);
    if (symbols.length > 0) {
      expect(names).toContain("Point");
    }
  });
});
