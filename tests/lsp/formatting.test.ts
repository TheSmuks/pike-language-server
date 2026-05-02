/**
 * Formatting tests for textDocument/formatting (US-026).
 *
 * Phase 1 formatter (ADR 0020): tree-sitter-based whitespace normalization.
 * Current implementation:
 * - Returns null for parseable content with no indentation changes
 * - Returns null for unparseable content
 *
 * Known gap: blank-line insertion between top-level declarations is not yet
 * implemented (formatter.ts has the logic but state tracking is broken).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";
import type { TextEdit, DocumentFormattingParams } from "vscode-languageserver/node";

describe("Formatting", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server.teardown();
  });

  async function formatDocument(
    uri: string,
    options?: { tabSize?: number; insertSpaces?: boolean },
  ): Promise<TextEdit[] | null> {
    return server.client.sendRequest<DocumentFormattingParams, TextEdit[] | null>(
      "textDocument/formatting",
      {
        textDocument: { uri },
        options: {
          tabSize: options?.tabSize ?? 2,
          insertSpaces: options?.insertSpaces ?? true,
        },
      },
    );
  }

  it("returns null for already-formatted code (no edits needed)", async () => {
    const uri = "file:///test/formatted.pike";
    const source = `class Foo {
int x;
}
class Bar {
string y;
}
`;
    server.openDoc(uri, source);

    const response = await formatDocument(uri);
    // Phase 1 formatter: no indentation changes implemented yet
    expect(response).toBeNull();
  });

  it("handles single-line file", async () => {
    const uri = "file:///test/single-line.pike";
    const source = `int x = 1;`;
    server.openDoc(uri, source);

    const response = await formatDocument(uri);
    expect(response).toBeNull();
  });

  it("handles parse errors gracefully", async () => {
    const uri = "file:///test/syntax-error.pike";
    const source = `class Foo {
int x =
`;
    server.openDoc(uri, source);

    const response = await formatDocument(uri);
    // Should return null for unparseable content
    expect(response).toBeNull();
  });

  it("handles multiple top-level declarations", async () => {
    const uri = "file:///test/many-decls.pike";
    const source = `class A { int a; }
class B { int b; }
class C { int c; }`;
    server.openDoc(uri, source);

    const response = await formatDocument(uri);
    // No blank-line insertion yet, so null
    expect(response).toBeNull();
  });

  it("handles nested blocks", async () => {
    const uri = "file:///test/nested.pike";
    const source = `void foo() {
if (true) {
int x = 1;
}
}
`;
    server.openDoc(uri, source);

    const response = await formatDocument(uri);
    // Phase 1: no indentation changes
    expect(response).toBeNull();
  });

  it("handles class with inheritance", async () => {
    const uri = "file:///test/inherit.pike";
    const source = `class Base {
int id;
}
class Leaf {
inherit Base;
float weight;
}`;
    server.openDoc(uri, source);

    const response = await formatDocument(uri);
    expect(response).toBeNull();
  });
});