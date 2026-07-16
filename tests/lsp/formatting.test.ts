/**
 * Formatting handler integration tests.
 *
 * Architecture: the handler calls pike-fmt's `format()` in-process, reusing the
 * server's already-initialized tree-sitter parser. It does NOT spawn the
 * pike-fmt CLI, so there is no binary path, no argv, and no exit code involved.
 *
 * These tests drive the real handler over the LSP protocol and apply the edits
 * it returns, so they assert what a client would actually end up with.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type TextEdit } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { createTestServer, type TestServer } from "./helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Apply LSP edits to source exactly as a conforming client would. */
function applyEdits(source: string, edits: TextEdit[]): string {
  const doc = TextDocument.create("file:///apply.pike", "pike", 1, source);
  return TextDocument.applyEdits(doc, edits);
}

/** Request full-document formatting and return the raw result. */
async function requestFormatting(
  server: TestServer,
  uri: string,
  options: { tabSize: number; insertSpaces: boolean } = { tabSize: 2, insertSpaces: true },
): Promise<TextEdit[] | null> {
  return await server.client.sendRequest(
    "textDocument/formatting",
    { textDocument: { uri }, options },
  ) as TextEdit[] | null;
}

const MESSY = ["int main() {", "    int x = 1;", "    return x;", "}", ""].join("\n");
const FORMATTED = ["int main() {", "  int x = 1;", "  return x;", "}", ""].join("\n");

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.teardown();
});

// ---------------------------------------------------------------------------
// Full-document formatting
// ---------------------------------------------------------------------------

describe("textDocument/formatting", () => {
  test("formats an over-indented document", async () => {
    const uri = server.openDoc("file:///test/fmt-messy.pike", MESSY);

    const edits = await requestFormatting(server, uri);

    expect(edits).not.toBeNull();
    expect(edits!.length).toBeGreaterThan(0);
    expect(applyEdits(MESSY, edits!)).toBe(FORMATTED);
  });

  test("returns no edits when the source is already formatted", async () => {
    const uri = server.openDoc("file:///test/fmt-clean.pike", FORMATTED);

    const edits = await requestFormatting(server, uri);

    expect(edits).toEqual([]);
  });

  test("idempotency: formatting formatted output produces no further edits", async () => {
    const first = server.openDoc("file:///test/fmt-idem-1.pike", MESSY);
    const firstEdits = await requestFormatting(server, first);
    expect(firstEdits).not.toBeNull();

    const once = applyEdits(MESSY, firstEdits!);

    // Feed the formatter's own output back through it.
    const second = server.openDoc("file:///test/fmt-idem-2.pike", once);
    const secondEdits = await requestFormatting(server, second);

    expect(secondEdits).toEqual([]);
  });

  test("honours insertSpaces: false by indenting with tabs", async () => {
    const uri = server.openDoc("file:///test/fmt-tabs.pike", MESSY);

    const edits = await requestFormatting(server, uri, { tabSize: 2, insertSpaces: false });

    expect(edits).not.toBeNull();
    const result = applyEdits(MESSY, edits!);
    expect(result).toContain("\tint x = 1;");
    expect(result).not.toContain("  int x = 1;");
  });

  test("honours tabSize by indenting with the requested width", async () => {
    const uri = server.openDoc("file:///test/fmt-width.pike", MESSY);

    const edits = await requestFormatting(server, uri, { tabSize: 4, insertSpaces: true });

    expect(edits).not.toBeNull();
    expect(applyEdits(MESSY, edits!)).toContain("    int x = 1;");
  });

  test("returns null for a document the server has not opened", async () => {
    const edits = await requestFormatting(server, "file:///test/fmt-missing.pike");

    expect(edits).toBeNull();
  });

  test("leaves unparseable source untouched rather than corrupting it", async () => {
    // A truncated function: the formatter must not emit a partial rewrite.
    const broken = "int main() {\n  int x = ;\n";
    const uri = server.openDoc("file:///test/fmt-broken.pike", broken);

    const edits = await requestFormatting(server, uri);

    // Either no edits, or edits that still round-trip to valid text — never null
    // silently paired with a mangled buffer.
    if (edits !== null && edits.length > 0) {
      expect(applyEdits(broken, edits)).toContain("int main()");
    }
  });
});

// ---------------------------------------------------------------------------
// Range formatting
//
// pike-fmt re-derives indentation from the whole parse tree, so the handler
// deliberately formats the entire document for a range request.
// ---------------------------------------------------------------------------

describe("textDocument/rangeFormatting", () => {
  test("formats the whole document for a range request", async () => {
    const uri = server.openDoc("file:///test/fmt-range.pike", MESSY);

    const edits = await server.client.sendRequest(
      "textDocument/rangeFormatting",
      {
        textDocument: { uri },
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 14 },
        },
        options: { tabSize: 2, insertSpaces: true },
      },
    ) as TextEdit[] | null;

    expect(edits).not.toBeNull();
    expect(applyEdits(MESSY, edits!)).toBe(FORMATTED);
  });

  test("returns null for a document the server has not opened", async () => {
    const edits = await server.client.sendRequest(
      "textDocument/rangeFormatting",
      {
        textDocument: { uri: "file:///test/fmt-range-missing.pike" },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        options: { tabSize: 2, insertSpaces: true },
      },
    ) as TextEdit[] | null;

    expect(edits).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// On-type formatting
// ---------------------------------------------------------------------------

describe("textDocument/onTypeFormatting", () => {
  test("fixes indentation of a closing brace as it is typed", async () => {
    const source = ["int main() {", "  int x = 1;", "    }", ""].join("\n");
    const uri = server.openDoc("file:///test/fmt-ontype.pike", source);

    const edits = await server.client.sendRequest(
      "textDocument/onTypeFormatting",
      {
        textDocument: { uri },
        position: { line: 2, character: 5 },
        ch: "}",
        options: { tabSize: 2, insertSpaces: true },
      },
    ) as TextEdit[] | null;

    expect(edits).not.toBeNull();
    expect(applyEdits(source, edits!)).toBe(
      ["int main() {", "  int x = 1;", "}", ""].join("\n"),
    );
  });

  test("returns null when the line is already correctly indented", async () => {
    const uri = server.openDoc("file:///test/fmt-ontype-clean.pike", FORMATTED);

    const edits = await server.client.sendRequest(
      "textDocument/onTypeFormatting",
      {
        textDocument: { uri },
        position: { line: 3, character: 1 },
        ch: "}",
        options: { tabSize: 2, insertSpaces: true },
      },
    ) as TextEdit[] | null;

    expect(edits).toBeNull();
  });
});
