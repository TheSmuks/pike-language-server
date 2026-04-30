/**
 * Code action tests (US-018).
 *
 * Tests textDocument/codeAction via LSP protocol.
 * Verifies remove-unused-variable action for Pike compiler warnings.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";

interface CodeActionResult {
  title: string;
  kind: string;
  edit?: {
    changes?: Record<string, Array<{
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      newText: string;
    }>>;
  };
  diagnostics?: Array<{
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    message: string;
    source?: string;
  }>;
}

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.teardown();
});

describe("US-018: textDocument/codeAction", () => {
  test("provides remove-unused-variable action for unused local", async () => {
    const src = [
      "int main() {",
      "  int unused = 42;",
      "  return 0;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/codeaction-unused.pike", src);

    // Simulate diagnostic from Pike compiler
    const result = await server.client.sendRequest(
      "textDocument/codeAction",
      {
        textDocument: { uri },
        range: {
          start: { line: 1, character: 6 },
          end: { line: 1, character: 12 },
        },
        context: {
          diagnostics: [
            {
              range: {
                start: { line: 1, character: 0 },
                end: { line: 1, character: 0 },
              },
              message: "Unused local variable 'unused'",
              source: "pike",
              severity: 2,
            },
          ],
        },
      },
    ) as CodeActionResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);

    const action = result![0];
    expect(action.title).toBe("Remove unused variable");
    expect(action.kind).toBe("quickfix");
    expect(action.edit).toBeDefined();
    expect(action.edit!.changes).toBeDefined();

    const edits = action.edit!.changes![uri];
    expect(edits).toBeDefined();
    expect(edits.length).toBe(1);

    // Edit should delete line 1 (the unused variable declaration)
    const edit = edits[0];
    expect(edit.newText).toBe("");
    expect(edit.range.start.line).toBe(1);
    expect(edit.range.start.character).toBe(0);
    expect(edit.range.end.line).toBe(2);
    expect(edit.range.end.character).toBe(0);
  });

  test("returns empty array when no diagnostics match", async () => {
    const src = [
      "int main() {",
      "  int x = 42;",
      "  return x;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/codeaction-used.pike", src);

    const result = await server.client.sendRequest(
      "textDocument/codeAction",
      {
        textDocument: { uri },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        context: {
          diagnostics: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
              message: "Some other warning",
              source: "pike",
              severity: 2,
            },
          ],
        },
      },
    ) as CodeActionResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBe(0);
  });

  test("returns empty for used variable with unused diagnostic (no false positives)", async () => {
    const src = [
      "int main() {",
      "  int used = 42;",
      "  return used;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/codeaction-nofix.pike", src);

    // Even if someone requests code actions, but the diagnostic
    // is NOT "Unused local variable", no action should appear.
    const result = await server.client.sendRequest(
      "textDocument/codeAction",
      {
        textDocument: { uri },
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 0 },
        },
        context: {
          diagnostics: [
            {
              range: {
                start: { line: 1, character: 0 },
                end: { line: 1, character: 0 },
              },
              message: "Bad assignment",
              source: "pike",
              severity: 1,
            },
          ],
        },
      },
    ) as CodeActionResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBe(0);
  });

  test("removes last line correctly", async () => {
    const src = [
      "int main() {",
      "  return 0;",
      "  int unused = 1;",
    ].join("\n");
    const uri = server.openDoc("file:///test/codeaction-lastline.pike", src);

    const result = await server.client.sendRequest(
      "textDocument/codeAction",
      {
        textDocument: { uri },
        range: {
          start: { line: 2, character: 0 },
          end: { line: 2, character: 0 },
        },
        context: {
          diagnostics: [
            {
              range: {
                start: { line: 2, character: 0 },
                end: { line: 2, character: 0 },
              },
              message: "Unused local variable 'unused'",
              source: "pike",
              severity: 2,
            },
          ],
        },
      },
    ) as CodeActionResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);

    const edits = result![0].edit!.changes![uri];
    expect(edits.length).toBe(1);

    // Last line: edit should delete from previous line's end to this line's end
    const edit = edits[0];
    expect(edit.newText).toBe("");
    expect(edit.range.start.line).toBe(1);
    expect(edit.range.end.line).toBe(2);
  });

  test("ignores diagnostics from other sources", async () => {
    const src = [
      "int main() {",
      "  int unused = 42;",
      "  return 0;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/codeaction-other-source.pike", src);

    // Diagnostic from a different source (e.g., tree-sitter parse)
    const result = await server.client.sendRequest(
      "textDocument/codeAction",
      {
        textDocument: { uri },
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 0 },
        },
        context: {
          diagnostics: [
            {
              range: {
                start: { line: 1, character: 0 },
                end: { line: 1, character: 0 },
              },
              message: "Unused local variable 'unused'",
              source: "tree-sitter",
              severity: 2,
            },
          ],
        },
      },
    ) as CodeActionResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBe(0);
  });
});
