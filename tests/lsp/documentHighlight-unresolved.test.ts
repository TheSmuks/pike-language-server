/**
 * Highlights and references on a name this file cannot resolve on its own.
 *
 * A member of an imported module, a macro from an include, a method reached
 * through `->` — the declaration is elsewhere, so the local symbol table
 * records the reference with `resolvesTo: null`. Both capabilities read that
 * null as "no symbol here" and answered nothing, even though documentHighlight
 * is defined as the occurrences *scoped to this file*, which are known.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";

interface HighlightResult {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  kind?: number;
}

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.teardown();
});

describe("documentHighlight on an unresolved name", () => {
  test("highlights both uses of a member reached through the same receiver", async () => {
    const src = [
      "int main(object g) {",
      "  write(g->greet());",
      "  write(g->greet());",
      "  return 0;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/highlight-arrow-unresolved.pike", src);

    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 1, character: 11 },
    }) as HighlightResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.map(h => h.range.start.line).sort()).toEqual([1, 2]);
  });

  test("does not highlight the same member name under a different receiver", async () => {
    const src = [
      "int main(object a, object b) {",
      "  write(a->greet());",
      "  write(b->greet());",
      "  return 0;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/highlight-arrow-receivers.pike", src);

    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 1, character: 11 },
    }) as HighlightResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.map(h => h.range.start.line)).toEqual([1]);
  });

  test("highlights a macro that comes from elsewhere", async () => {
    const src = [
      "int main() {",
      "  write(LIBRARY_VERSION);",
      "  write(LIBRARY_VERSION);",
      "  return 0;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/highlight-macro-unresolved.pike", src);

    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 1, character: 9 },
    }) as HighlightResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.map(h => h.range.start.line).sort()).toEqual([1, 2]);
  });
});

describe("a dotted type names a member too", () => {
  test("highlights the member segment of `Stdio.File` in type position", async () => {
    const src = [
      "int main() {",
      "  Stdio.File f = Stdio.File();",
      "  return 0;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/highlight-dotted-type.pike", src);

    // Cursor on `File` in the declared type, not in the constructor call.
    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 1, character: 8 },
    }) as HighlightResult[] | null;

    expect(result).not.toBeNull();
    // Both `File` segments on the line: the type and the constructor call.
    const starts = result!.map(h => h.range.start.character).sort((a, b) => a - b);
    expect(starts).toEqual([8, 23]);
  });
});
