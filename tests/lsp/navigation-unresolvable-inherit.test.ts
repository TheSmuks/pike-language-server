/**
 * Hover and go-to-definition on an inherit whose target cannot be resolved.
 *
 * The server already treats the inherit declaration as the definition of the
 * name: from a use elsewhere in the file, definition jumps to it and hover
 * renders it. Asked at that declaration itself, both answered nothing — the one
 * position the server hands out as the answer everywhere else. Both read
 * getDefinitionAt, which follows an inherit through to its target and answers
 * null when the target is not in this file.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";

interface LocationResult {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

const SRC = [
  "inherit NonExistentClass;",
  "",
  "int main() {",
  "  NonExistentClass o = NonExistentClass();",
  "  return 0;",
  "}",
].join("\n");

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.teardown();
});

describe("an inherit that names nothing resolvable", () => {
  test("definition from a use points at the inherit", async () => {
    const uri = server.openDoc("file:///test/undef-inherit-use.pike", SRC);

    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 3, character: 3 },
    }) as LocationResult | null;

    expect(result).not.toBeNull();
    expect(result!.range.start).toEqual({ line: 0, character: 8 });
  });

  test("definition on the inherit itself answers the same location", async () => {
    const uri = server.openDoc("file:///test/undef-inherit-decl.pike", SRC);

    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 0, character: 8 },
    }) as LocationResult | null;

    expect(result).not.toBeNull();
    expect(result!.range.start).toEqual({ line: 0, character: 8 });
  });

  test("declaration on the inherit itself answers too", async () => {
    const uri = server.openDoc("file:///test/undef-inherit-declreq.pike", SRC);

    const result = await server.client.sendRequest("textDocument/declaration", {
      textDocument: { uri },
      position: { line: 0, character: 8 },
    }) as LocationResult | null;

    expect(result).not.toBeNull();
    expect(result!.range.start).toEqual({ line: 0, character: 8 });
  });

  test("hover on the inherit itself renders it, as it does from a use", async () => {
    const uri = server.openDoc("file:///test/undef-inherit-hover.pike", SRC);

    const result = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line: 0, character: 8 },
    }) as { contents: { value: string } } | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("NonExistentClass");
  });
});
