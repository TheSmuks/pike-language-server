/**
 * Background workspace indexing tests (US-021).
 *
 * Tests that the LSP discovers and indexes workspace .pike/.pmod files
 * on startup via background indexing.
 *
 * Methodology: create a temp directory with .pike files, initialize the
 * server with rootUri pointing to that directory, then verify workspace/symbol
 * finds classes/functions from files that were never explicitly opened.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let server: TestServer;
let tempDir: string;

beforeAll(async () => {
  // Create temp directory with .pike files
  tempDir = mkdtempSync(join(tmpdir(), "pike-lsp-bg-index-"));

  writeFileSync(join(tempDir, "animal.pike"), [
    "class Animal {",
    "  string name;",
    "  void speak() { }",
    "}",
  ].join("\n"));

  writeFileSync(join(tempDir, "math.pike"), [
    "int add(int a, int b) {",
    "  return a + b;",
    "}",
  ].join("\n"));

  // Non-pike file — should be ignored
  writeFileSync(join(tempDir, "readme.txt"), "Not a Pike file");

  // Initialize server with workspaceRoot pointing to temp dir.
  // The MessageConnection handles server-initiated requests properly,
  // so workDoneProgress/create won't hang.
  server = await createTestServer({
    rootUri: `file://${tempDir}`,
  });

  // Wait for background indexing to complete (fire-and-forget in onInitialized).
  // With 2 small files this should take <2s including the progress timeout.
  await new Promise((r) => setTimeout(r, 3000));
});

afterAll(async () => {
  await server.teardown();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("US-021: Background workspace indexing", () => {
  test("workspace symbol finds class from unopened file", async () => {
    const result = await server.client.sendRequest("workspace/symbol", {
      query: "Animal",
    }) as Array<{ name: string; kind: number; location: { uri: string } }> | null;

    expect(result).not.toBeNull();
    const found = result!.find(s => s.name === "Animal" && s.kind === 5);
    expect(found).toBeDefined();
    expect(found!.location.uri).toContain("animal.pike");
  });

  test("workspace symbol finds function from unopened file", async () => {
    const result = await server.client.sendRequest("workspace/symbol", {
      query: "add",
    }) as Array<{ name: string; kind: number; location: { uri: string } }> | null;

    expect(result).not.toBeNull();
    const found = result!.find(s => s.name === "add" && s.kind === 12);
    expect(found).toBeDefined();
    expect(found!.location.uri).toContain("math.pike");
  });

  test("non-pike files are not indexed", async () => {
    const result = await server.client.sendRequest("workspace/symbol", {
      query: "Not",
    }) as Array<{ name: string; location: { uri: string } }> | null;

    // readme.txt should not produce any symbols
    const readmeHit = (result ?? []).find(
      s => s.location?.uri?.includes("readme.txt"),
    );
    expect(readmeHit).toBeUndefined();
  });

  test("concurrent requests respond during indexing", async () => {
    // Open a doc and immediately send concurrent requests
    const src = "class ConcurrentTest { }";
    const uri = server.openDoc(`file:///test/concurrent.pike`, src);

    // Fire multiple concurrent requests — all should respond (not hang)
    const [symbols, docSymbols, highlights] = await Promise.all([
      server.client.sendRequest("workspace/symbol", { query: "ConcurrentTest" }),
      server.client.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri },
      }),
      server.client.sendRequest("textDocument/documentHighlight", {
        textDocument: { uri },
        position: { line: 0, character: 6 },
      }),
    ]);

    expect(symbols).toBeDefined();
    expect(docSymbols).toBeDefined();
    expect(highlights).toBeDefined();
  });
});
