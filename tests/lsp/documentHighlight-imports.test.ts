/**
 * Highlights and references on an import or inherit that names another file.
 *
 * The LSP audit found both capabilities silent on the module name in
 * `import Stdio;`. Both route through getDefinitionAt, which answers the
 * question go-to-definition asks — "where does this lead?" — and deliberately
 * answers null when the target lives in another file so navigation can take
 * the cross-file path. Highlight and includeDeclaration want the occurrence
 * under the cursor instead, and inherited that null.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";

interface HighlightResult {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  kind?: number;
}

interface LocationResult {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.teardown();
});

describe("documentHighlight on a module name", () => {
  test("highlights the name in `import Stdio;`", async () => {
    const src = ["import Stdio;", "", "int main() { return 0; }"].join("\n");
    const uri = server.openDoc("file:///test/highlight-import-stdlib.pike", src);

    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 0, character: 7 },
    }) as HighlightResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThanOrEqual(1);
    expect(result![0].range.start).toEqual({ line: 0, character: 7 });
  });

  test("highlights the name in an inherit of another file", async () => {
    const src = ["inherit some_other_module;", "", "int main() { return 0; }"].join("\n");
    const uri = server.openDoc("file:///test/highlight-inherit-module.pike", src);

    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 0, character: 8 },
    }) as HighlightResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThanOrEqual(1);
    expect(result![0].range.start).toEqual({ line: 0, character: 8 });
  });

  test("still highlights every use of a same-file class through its inherit", async () => {
    const src = [
      "class A { int value() { return 1; } }",
      "class C {",
      "  inherit A;",
      "  int sum() { return A::value(); }",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/highlight-inherit-samefile.pike", src);

    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 2, character: 10 },
    }) as HighlightResult[] | null;

    expect(result).not.toBeNull();
    // The class declaration on line 0 and the qualified use on line 3.
    const lines = result!.map(h => h.range.start.line).sort();
    expect(lines).toContain(0);
    expect(lines).toContain(3);
  });
});

describe("references with includeDeclaration on a module name", () => {
  test("returns the import itself rather than nothing", async () => {
    const src = ["import some_other_module;", "", "int main() { return 0; }"].join("\n");
    const uri = server.openDoc("file:///test/refs-import-module.pike", src);

    const result = await server.client.sendRequest("textDocument/references", {
      textDocument: { uri },
      position: { line: 0, character: 7 },
      context: { includeDeclaration: true },
    }) as LocationResult[];

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].range.start).toEqual({ line: 0, character: 7 });
  });
});

describe("the local alias of an inherit", () => {
  const src = [
    'inherit "engine.pike" : motor;',
    "",
    "int main() { return 0; }",
  ].join("\n");

  test("documentHighlight marks the alias itself", async () => {
    const uri = server.openDoc("file:///test/highlight-inherit-alias.pike", src);

    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 0, character: 24 },
    }) as HighlightResult[] | null;

    expect(result).not.toBeNull();
    // The alias is a name this file introduces; the path string is not it.
    expect(result![0].range).toEqual({
      start: { line: 0, character: 24 },
      end: { line: 0, character: 29 },
    });
  });

  test("references with includeDeclaration returns the alias", async () => {
    const uri = server.openDoc("file:///test/refs-inherit-alias.pike", src);

    const result = await server.client.sendRequest("textDocument/references", {
      textDocument: { uri },
      position: { line: 0, character: 24 },
      context: { includeDeclaration: true },
    }) as LocationResult[];

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].range.start).toEqual({ line: 0, character: 24 });
  });
});
