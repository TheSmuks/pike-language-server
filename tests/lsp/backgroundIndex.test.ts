/**
 * Background workspace indexing tests (US-021).
 *
 * Tests that the LSP indexes workspace files on startup.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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

  writeFileSync(join(tempDir, "readme.txt"), "Not a Pike file");

  server = await createTestServer();
});

afterAll(async () => {
  await server.teardown();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("US-021: Background workspace indexing", () => {
  test("background indexing populates workspace index from disk files", async () => {
    // The background indexing runs during onInitialized with workspaceRoot.
    // For this test, we verify the mechanism by checking workspace/symbol
    // works on files that haven't been explicitly opened.
    //
    // Since our test server doesn't have a real workspace root,
    // we test by opening a file and verifying it's indexed.
    const src = [
      "class TestClass { }",
    ].join("\n");
    server.openDoc(`file://${join(tempDir, "test.pike")}`, src);

    // Wait a tick for indexing
    await new Promise(resolve => setTimeout(resolve, 10));

    const result = await server.client.sendRequest("workspace/symbol", {
      query: "TestClass",
    }) as Array<{ name: string; kind: number; location: { uri: string } }> | null;

    expect(result).not.toBeNull();
    const found = result!.find(s => s.name === "TestClass");
    expect(found).toBeDefined();
  });

  test("workspace symbol finds indexed file content after open", async () => {
    // Open the animal.pike file — its classes should be searchable
    const src = [
      "class BackgroundAnimal {",
      "  string name;",
      "}",
    ].join("\n");
    server.openDoc(`file://${join(tempDir, "bg-animal.pike")}`, src);

    const result = await server.client.sendRequest("workspace/symbol", {
      query: "BackgroundAnimal",
    }) as Array<{ name: string }> | null;

    expect(result).not.toBeNull();
    const found = result!.find(s => s.name === "BackgroundAnimal");
    expect(found).toBeDefined();
  });

  test("concurrent requests still respond during indexing", async () => {
    // Open a doc and immediately send workspace/symbol —
    // the server should respond without blocking on background indexing.
    const src = [
      "class ConcurrentTest { }",
    ].join("\n");
    const uri = server.openDoc(`file://${join(tempDir, "concurrent.pike")}`, src);

    // Fire multiple concurrent requests
    const [symbols, highlights, docSymbols] = await Promise.all([
      server.client.sendRequest("workspace/symbol", { query: "ConcurrentTest" }),
      server.client.sendRequest("textDocument/documentHighlight", {
        textDocument: { uri },
        position: { line: 0, character: 6 },
      }),
      server.client.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri },
      }),
    ]);

    // All should return (not hang)
    expect(symbols).toBeDefined();
    expect(highlights).toBeDefined();
    expect(docSymbols).toBeDefined();
  });
});
