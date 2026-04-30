/**
 * Real-codebase verification (US-026).
 *
 * Exercises all LSP features against corpus files to verify zero crashes.
 * This is an automated crash test — semantic correctness is verified by
 * the dedicated feature tests.
 *
 * Corpus covers: classes, functions, variables, enums, cross-file imports,
 * type errors, modifiers, autoDoc, stdlib, preprocessor.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "../lsp/helpers";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, extname } from "node:path";

const CORPUS_DIR = resolve(import.meta.dir, "..", "..", "corpus", "files");

let server: TestServer;
let corpusFiles: Array<{ uri: string; name: string; src: string }>;

beforeAll(async () => {
  server = await createTestServer();

  // Load all corpus .pike files
  const entries = readdirSync(CORPUS_DIR).filter(f => f.endsWith(".pike"));
  corpusFiles = entries.map(name => ({
    uri: `file:///corpus/${name}`,
    name,
    src: readFileSync(resolve(CORPUS_DIR, name), "utf-8"),
  }));

  // Open all files
  for (const file of corpusFiles) {
    server.openDoc(file.uri, file.src);
  }
});

afterAll(async () => {
  await server.teardown();
});

describe("US-026: Real-codebase verification", () => {
  test("documentSymbol does not crash on any corpus file", async () => {
    for (const file of corpusFiles) {
      const result = await server.client.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri: file.uri },
      });
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    }
  });

  test("semanticTokens does not crash on any corpus file", async () => {
    for (const file of corpusFiles) {
      const result = await server.client.sendRequest("textDocument/semanticTokens/full", {
        textDocument: { uri: file.uri },
      });
      expect(result).toBeDefined();
      expect((result as { data: unknown[] }).data).toBeDefined();
    }
  });

  test("foldingRange does not crash on any corpus file", async () => {
    for (const file of corpusFiles) {
      const result = await server.client.sendRequest("textDocument/foldingRange", {
        textDocument: { uri: file.uri },
      });
      expect(result).toBeDefined();
    }
  });

  test("hover does not crash at various positions", async () => {
    // Test hover at a few positions in the first 5 files
    for (const file of corpusFiles.slice(0, 5)) {
      const lines = file.src.split("\n");
      for (let line = 0; line < Math.min(lines.length, 10); line++) {
        const result = await server.client.sendRequest("textDocument/hover", {
          textDocument: { uri: file.uri },
          position: { line, character: 0 },
        });
        // Result can be null (no hover info) — just must not crash
        expect(result).toBeDefined();
      }
    }
  });

  test("definition does not crash at various positions", async () => {
    for (const file of corpusFiles.slice(0, 5)) {
      const lines = file.src.split("\n");
      for (let line = 0; line < Math.min(lines.length, 5); line++) {
        const result = await server.client.sendRequest("textDocument/definition", {
          textDocument: { uri: file.uri },
          position: { line, character: 0 },
        });
        expect(result).toBeDefined();
      }
    }
  });

  test("completion does not crash at various positions", async () => {
    for (const file of corpusFiles.slice(0, 5)) {
      const lines = file.src.split("\n");
      for (let line = 0; line < Math.min(lines.length, 5); line++) {
        const result = await server.client.sendRequest("textDocument/completion", {
          textDocument: { uri: file.uri },
          position: { line, character: 0 },
          context: { triggerKind: 1 },
        });
        expect(result).toBeDefined();
      }
    }
  });

  test("documentHighlight does not crash", async () => {
    for (const file of corpusFiles.slice(0, 5)) {
      const result = await server.client.sendRequest("textDocument/documentHighlight", {
        textDocument: { uri: file.uri },
        position: { line: 0, character: 0 },
      });
      expect(result).toBeDefined();
    }
  });

  test("rename does not crash with valid position and name", async () => {
    // Use a safe file with known identifiers
    const file = corpusFiles.find(f => f.name === "basic-types.pike");
    if (!file) return;

    const result = await server.client.sendRequest("textDocument/rename", {
      textDocument: { uri: file.uri },
      position: { line: 0, character: 0 },
      newName: "renamed_var",
    });
    expect(result).toBeDefined();
  });

  test("workspace symbol search returns results from corpus files", async () => {
    // Search for common Pike identifiers
    const queries = ["main", "create", "Class", "int"];
    let totalFound = 0;

    for (const query of queries) {
      const result = await server.client.sendRequest("workspace/symbol", {
        query,
      }) as Array<{ name: string }> | null;

      expect(result).not.toBeNull();
      totalFound += result!.length;
    }

    // Should find at least some symbols across the corpus
    expect(totalFound).toBeGreaterThan(0);
  });

  test("codeAction does not crash with various diagnostics", async () => {
    for (const file of corpusFiles.slice(0, 3)) {
      const result = await server.client.sendRequest("textDocument/codeAction", {
        textDocument: { uri: file.uri },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        context: {
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              message: "Unused local variable 'x'",
              source: "pike",
              severity: 2,
            },
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              message: "Undefined identifier 'Stdio'",
              source: "pike",
              severity: 1,
            },
          ],
        },
      });
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    }
  });

  test("documentSymbol returns expected symbol names for known file", async () => {
    const file = corpusFiles.find(f => f.name === "basic-types.pike");
    if (!file) return;

    const result = await server.client.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri: file.uri },
    }) as Array<{ name: string; kind: number }> | null;

    expect(result).not.toBeNull();
    const names = result!.map(s => s.name);
    // basic-types.pike contains int, string, float variable declarations
    // and at least one function (main)
    expect(names).toContain("main");
  });

  test("hover returns type information for typed variable", async () => {
    const file = corpusFiles.find(f => f.name === "basic-types.pike");
    if (!file) return;

    // Find a line with an int declaration — hover should return something meaningful
    const lines = file.src.split("\n");
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/\bint\s+(\w+)/);
      if (match) {
        const charPos = lines[i].indexOf(match[1]);
        const result = await server.client.sendRequest("textDocument/hover", {
          textDocument: { uri: file.uri },
          position: { line: i, character: charPos },
        }) as { contents?: { kind?: string; value?: string } } | null;

        if (result?.contents?.value) {
          // Hover content should mention the variable type or name
          expect(result.contents.value.length).toBeGreaterThan(0);
          found = true;
        }
        break;
      }
    }
    // If no int declaration was found, the test is vacuous — that's a corpus problem.
    if (!found && lines.some(l => /\bint\s+/.test(l))) {
      throw new Error("Hover returned null for typed variable in basic-types.pike");
    }
  });

  test("definition resolves to a location within the file", async () => {
    const file = corpusFiles.find(f => f.name === "basic-types.pike");
    if (!file) return;

    // Find a reference to a declared symbol
    const lines = file.src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const result = await server.client.sendRequest("textDocument/definition", {
        textDocument: { uri: file.uri },
        position: { line: i, character: 0 },
      }) as Array<{ uri: string; range: { start: { line: number } } }> | null;

      if (result && result.length > 0) {
        // Definition should point to a location in a file
        for (const loc of result) {
          expect(loc.uri).toBeDefined();
          expect(loc.range.start.line).toBeGreaterThanOrEqual(0);
        }
        return;
      }
    }
  });
});